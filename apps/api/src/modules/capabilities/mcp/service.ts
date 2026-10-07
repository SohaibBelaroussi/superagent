import { randomUUID } from 'node:crypto';
import type { ToolsInput } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import { createTool, type Tool } from '@mastra/core/tools';
import { MCPClient, type SerializableMCPToolDefinition } from '@mastra/mcp';
import type { CreateMcpServerInput, McpGrant, McpServer, UpdateMcpServerInput } from '@superagent/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { type McpServerRow, type McpToolDefinition, mcpServers, plugins } from '../../../db/schema';
import { ApiError } from '../../../http/problem';
import { Mutex } from '../../../util/mutex';
import { assertPublicUrl, BlockedUrlError, type ResolveHost } from '../../tools/web';
import type { RunnerClient } from '../../workspace/runner-client';
import { type SecretService, secretNames } from '../secrets';
import { mcpToolKeys } from './naming';

/** What a tool result may weigh when it reaches the model (like fetch_page's pages). */
const MAX_RESULT_CHARS = 50_000;
const MAX_REDIRECTS = 5;
/** A stdio server's first call may wait for its container to start. */
const STDIO_CONNECT_MS = 120_000;
const HTTP_CONNECT_MS = 30_000;

/** A stdio server's runner-side launch: what to run, where, with which environment. */
export interface LaunchSpec {
  packageId: string;
  command: string[];
  cwd: string | null;
  env: Record<string, string>;
  network: 'egress' | 'none';
}

export interface McpDeps {
  db: Db;
  secrets: SecretService;
  logger: IMastraLogger;
  /** stdio servers run in the runner's containers (decision D36); without it they can't start. */
  runner?: { client: RunnerClient; url: string; token: string };
  /** The agents and departments that grant a server, by its slug (deleting it is refused then). */
  grantedTo: (slug: string) => string[];
  resolveHost?: ResolveHost;
}

interface Entry {
  revision: number;
  client: MCPClient;
  /** The server's tools, rebuilt from their stored definitions without connecting. */
  tools: Map<string, Tool<unknown, unknown>>;
}

/** Arguments and results stay out of the logs: MCP clients log failing calls with their arguments. */
function redacting(logger: IMastraLogger): IMastraLogger {
  const scrub = (data: unknown) => {
    if (!data || typeof data !== 'object') return data;
    const { toolArgs: _args, args: _a, arguments: _b, result: _r, ...rest } = data as Record<string, unknown>;
    return rest;
  };
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (prop === 'debug' || prop === 'info' || prop === 'warn' || prop === 'error') {
        return (message: string, ...rest: unknown[]) =>
          (target[prop] as (m: string, ...r: unknown[]) => void)(message, ...rest.map(scrub));
      }
      // Called on the logger itself: its methods use private fields, which a proxy doesn't have.
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** An MCP server that forgot its session (it restarted or was stopped idle) answers 404. */
function lostSession(error: unknown): boolean {
  for (
    let e = error as { status?: number; message?: string; cause?: unknown } | undefined, i = 0;
    e && i < 5;
    i++
  ) {
    if (e.status === 404 || /\b404\b|no valid session/i.test(String(e.message ?? ''))) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Long results are cut before they reach the model. */
function capped(result: unknown): unknown {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (text === undefined || text.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, content: `${text.slice(0, MAX_RESULT_CHARS)}…` };
}

/**
 * MCP servers (decision D36): one @mastra/mcp client per server revision, tools discovered once and
 * kept in our table, and wrapper tools per grant (our names, the grant's allowlist and approvals).
 * HTTP servers reach public addresses only, unless the owner marked them private-network; stdio
 * servers run in the runner's containers, which relay their stdio as Streamable HTTP.
 */
export class McpService {
  private readonly rows = new Map<string, McpServerRow>();
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(slugs: string[]) => void>();
  private readonly lock = new Mutex();
  private readonly pluginNames = new Map<string, string>();
  private readonly logger: IMastraLogger;

  constructor(private readonly deps: McpDeps) {
    this.logger = redacting(deps.logger);
    deps.secrets.onChange((name) => void this.secretChanged(name));
  }

  /** Called with the slugs of servers whose tools changed: agents granting them are rebuilt. */
  onToolsChanged(listener: (slugs: string[]) => void): void {
    this.listeners.add(listener);
  }

  async load(): Promise<void> {
    const rows = await this.deps.db.select().from(mcpServers);
    const names = await this.deps.db.select({ id: plugins.id, name: plugins.name }).from(plugins);
    for (const { id, name } of names) this.pluginNames.set(id, name);
    for (const row of rows) this.rows.set(row.id, row);
    await Promise.all(rows.map((row) => this.hydrate(row)));
  }

  list(): McpServer[] {
    return [...this.rows.values()]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((row) => this.present(row));
  }

  get(id: string): McpServer {
    return this.present(this.row(id));
  }

  bySlug(slug: string): McpServerRow | undefined {
    return [...this.rows.values()].find((row) => row.slug === slug);
  }

  /** The servers of a plugin. */
  ofPlugin(pluginId: string): McpServerRow[] {
    return [...this.rows.values()].filter((row) => row.pluginId === pluginId);
  }

  /** Adds an HTTP server by hand and discovers its tools. */
  async create(input: CreateMcpServerInput): Promise<McpServer> {
    const id = await this.lock.run(async () => {
      if (this.bySlug(input.slug)) {
        throw new ApiError(409, 'mcp_server_exists', `An MCP server with slug "${input.slug}" exists`);
      }
      await this.requireSecrets(secretNames(input.headers));
      const url = this.checkUrl(input.url, input.allowPrivateNetwork ?? false);
      const [row] = await this.deps.db
        .insert(mcpServers)
        .values({
          id: randomUUID(),
          slug: input.slug,
          name: input.name,
          description: input.description ?? '',
          transport: 'http',
          url: url.toString(),
          headers: input.headers ?? {},
          allowPrivateNetwork: input.allowPrivateNetwork ?? false,
          timeoutMs: input.timeoutMs ?? 60_000,
          status: 'pending',
        })
        .returning();
      this.rows.set((row as McpServerRow).id, row as McpServerRow);
      return (row as McpServerRow).id;
    });
    return this.refresh(id).catch(() => this.get(id));
  }

  /** Rows a plugin install wrote: track them (their tools come from refresh). */
  adopt(rows: McpServerRow[], pluginName: string): void {
    for (const row of rows) {
      this.rows.set(row.id, row);
      if (row.pluginId) this.pluginNames.set(row.pluginId, pluginName);
    }
  }

  async update(id: string, input: UpdateMcpServerInput): Promise<McpServer> {
    const changed = await this.lock.run(async () => {
      const row = this.row(id);
      if (input.url !== undefined && row.transport !== 'http') {
        throw new ApiError(400, 'not_http', 'Only HTTP servers have a URL');
      }
      if (input.env !== undefined && row.transport !== 'stdio') {
        throw new ApiError(400, 'not_stdio', 'Only stdio servers have an environment');
      }
      await this.requireSecrets([...secretNames(input.headers), ...secretNames(input.env)]);
      const allowPrivate = input.allowPrivateNetwork ?? row.allowPrivateNetwork;
      const url =
        input.url !== undefined || input.allowPrivateNetwork !== undefined
          ? row.url && this.checkUrl(input.url ?? row.url, allowPrivate).toString()
          : row.url;
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({
          name: input.name ?? row.name,
          description: input.description ?? row.description,
          url,
          headers: input.headers ?? row.headers,
          env: input.env ?? row.env,
          allowPrivateNetwork: allowPrivate,
          enabled: input.enabled ?? row.enabled,
          timeoutMs: input.timeoutMs ?? row.timeoutMs,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
        .returning();
      this.rows.set(id, next as McpServerRow);
      await this.retire(id);
      await this.hydrate(next as McpServerRow);
      return (input.enabled ?? row.enabled) !== row.enabled;
    });
    if (changed) this.notify([this.row(id).slug]);
    return this.get(id);
  }

  /** Deletes a server added by hand. Refused while agents or departments grant it. */
  async remove(id: string): Promise<void> {
    await this.lock.run(async () => {
      const row = this.row(id);
      if (row.pluginId) {
        throw new ApiError(
          409,
          'plugin_owned',
          'This server came with a plugin: uninstall the plugin instead',
        );
      }
      const users = this.deps.grantedTo(row.slug);
      if (users.length > 0) {
        throw new ApiError(
          409,
          'mcp_server_granted',
          `It is granted to ${users.join(', ')}: remove the grants first`,
        );
      }
      await this.deps.db.delete(mcpServers).where(eq(mcpServers.id, id));
      await this.retire(id);
      this.rows.delete(id);
    });
  }

  /** Forgets a plugin's servers (its rows are deleted with the plugin). */
  async forgetPlugin(pluginId: string): Promise<string[]> {
    const gone = this.ofPlugin(pluginId);
    for (const row of gone) {
      await this.retire(row.id);
      this.rows.delete(row.id);
    }
    this.pluginNames.delete(pluginId);
    return gone.map((row) => row.slug);
  }

  /** Records that a server could not be set up (its plugin's install), where the owner sees it. */
  async fail(id: string, detail: string): Promise<void> {
    const [next] = await this.deps.db
      .update(mcpServers)
      .set({ status: 'failed', statusDetail: detail.slice(0, 1000), updatedAt: new Date() })
      .where(eq(mcpServers.id, id))
      .returning();
    if (next) this.rows.set(id, next as McpServerRow);
  }

  /** Asks the server for its tools and keeps them. The server's status says how it went. */
  async refresh(id: string): Promise<McpServer> {
    const before = JSON.stringify(this.row(id).tools);
    await this.lock.run(async () => {
      const row = this.row(id);
      if (!row.enabled) throw new ApiError(409, 'mcp_server_disabled', 'Enable the server first');
      const entry = this.entries.get(id) ?? (await this.hydrate(row));
      let update: Partial<McpServerRow>;
      try {
        const { definitions, errors } = await entry.client.listToolDefinitionsWithErrors();
        const found = definitions[row.slug];
        if (!found) throw new Error(errors[row.slug] ?? 'The server listed no tools');
        update = {
          status: 'ready',
          statusDetail: null,
          tools: Object.values(found).map((definition) => this.stored(definition)),
          toolsRefreshedAt: new Date(),
        };
      } catch (error) {
        update = { status: 'failed', statusDetail: String((error as Error)?.message ?? error).slice(0, 500) };
        this.logger.warn('MCP server discovery failed', { server: row.slug, error: update.statusDetail });
      }
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({ ...update, updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning();
      this.rows.set(id, next as McpServerRow);
      // The client stays; only the tools it serves are rebuilt.
      await this.hydrateTools(next as McpServerRow, entry);
    });
    const row = this.row(id);
    if (JSON.stringify(row.tools) !== before) this.notify([row.slug]);
    return this.present(row);
  }

  /** The wrapper tools a set of grants gives: the granted tools of enabled servers, our names. */
  toolsFor(grants: McpGrant[]): ToolsInput {
    const tools: ToolsInput = {};
    for (const grant of grants) {
      const row = this.bySlug(grant.server);
      const entry = row && this.entries.get(row.id);
      if (!row?.enabled || !entry) continue;
      const keys = mcpToolKeys(
        row.slug,
        row.tools.map((tool) => tool.name),
      );
      const allowed = grant.tools ? new Set(grant.tools) : undefined;
      for (const definition of row.tools) {
        const hydrated = entry.tools.get(definition.name);
        const key = keys.get(definition.name);
        if (!hydrated || !key || (allowed && !allowed.has(definition.name))) continue;
        tools[key] = createTool({
          id: key,
          description: (definition.description ?? definition.title ?? definition.name).slice(0, 1024),
          inputSchema: hydrated.inputSchema,
          requireApproval: grant.requireApproval ?? false,
          execute: (input, context) => this.call(row.id, definition.name, input, context),
        });
      }
    }
    return tools;
  }

  /** The tools a server lists, with the names agents see. */
  toolNames(slug: string): string[] {
    return this.bySlug(slug)?.tools.map((tool) => tool.name) ?? [];
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.retire(id)));
  }

  // --- calls ---

  private async call(id: string, name: string, input: unknown, context: unknown): Promise<unknown> {
    const row = this.rows.get(id);
    const entry = this.entries.get(id);
    const tool = entry?.tools.get(name);
    if (!row?.enabled || !entry || !tool?.execute) {
      throw new Error(`The MCP server's tool ${name} is not available right now`);
    }
    const run = () => (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, context);
    try {
      return capped(await run());
    } catch (error) {
      if (!lostSession(error)) throw error;
      // A 404 means the call never reached the server: reconnect and send it once more.
      await entry.client.reconnectServer(row.slug);
      return capped(await run());
    }
  }

  // --- clients ---

  /** Builds the server's client for its current revision and rebuilds its tools (no connection yet). */
  private async hydrate(row: McpServerRow): Promise<Entry> {
    const entry: Entry = {
      revision: row.revision,
      client: new MCPClient({
        id: `mcp:${row.id}:${row.revision}`,
        servers: { [row.slug]: await this.definition(row) },
        timeout: row.timeoutMs,
      }),
      tools: new Map(),
    };
    entry.client.__setLogger(this.logger);
    this.entries.set(row.id, entry);
    await this.hydrateTools(row, entry);
    return entry;
  }

  private async hydrateTools(row: McpServerRow, entry: Entry): Promise<void> {
    entry.tools.clear();
    for (const definition of row.tools) {
      try {
        const tool = await entry.client.toolFromDefinition({
          serverName: row.slug,
          definition: { ...definition, server: { name: row.slug } } as SerializableMCPToolDefinition,
        });
        entry.tools.set(definition.name, tool as Tool<unknown, unknown>);
      } catch (error) {
        this.logger.warn('An MCP tool could not be rebuilt', {
          server: row.slug,
          tool: definition.name,
          error,
        });
      }
    }
  }

  private async definition(row: McpServerRow) {
    if (row.transport === 'http') {
      return {
        url: new URL(row.url as string),
        requestInit: { headers: await this.deps.secrets.resolve(row.headers) },
        fetch: this.guardedFetch(row),
        timeout: row.timeoutMs,
        connectTimeout: HTTP_CONNECT_MS,
      };
    }
    const runner = this.deps.runner;
    return {
      url: new URL(`${runner?.url ?? 'http://runner.invalid'}/mcp/servers/${row.id}`),
      // The runner relays to the server's stdio; it speaks the 2025 revision of the protocol.
      protocolVersion: 'legacy' as const,
      fetch: this.runnerFetch(row),
      timeout: row.timeoutMs,
      connectTimeout: STDIO_CONNECT_MS,
    };
  }

  /** Public addresses only (unless the owner said otherwise), every redirect hop checked, same origin only. */
  private guardedFetch(row: McpServerRow) {
    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
      let url = new URL(input.toString());
      const origin = url.origin;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!row.allowPrivateNetwork) {
          try {
            await assertPublicUrl(url.toString(), this.deps.resolveHost);
          } catch (error) {
            throw new Error((error as Error).message);
          }
        }
        const response = await fetch(url, { ...init, redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get('location');
        if (!location) return response;
        const next = new URL(location, url);
        // Its headers carry credentials: they never follow a redirect to another origin.
        if (next.origin !== origin)
          throw new Error(`The MCP server redirected to another origin (${next.origin})`);
        url = next;
      }
      throw new Error('The MCP server redirected too many times');
    };
  }

  /** The runner's relay, with its token; a runner that restarted learns the server's launch again. */
  private runnerFetch(row: McpServerRow) {
    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const runner = this.deps.runner;
      if (!runner) throw new Error('stdio MCP servers need the runner (RUNNER_URL and RUNNER_TOKEN)');
      const send = () => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${runner.token}`);
        return fetch(input, { ...init, headers });
      };
      let response = await send();
      if (response.status === 409) {
        const problem = (await response
          .clone()
          .json()
          .catch(() => ({}))) as { code?: string };
        if (problem.code === 'launch_unknown') {
          await this.launch(this.row(row.id));
          response = await send();
        }
      }
      return response;
    };
  }

  /** Tells the runner how to start a stdio server (secrets resolved now, kept in its memory only). */
  async launch(row: McpServerRow): Promise<void> {
    const runner = this.deps.runner;
    if (!runner || row.transport !== 'stdio' || !row.pluginId || !row.command) return;
    const [plugin] = await this.deps.db
      .select({ network: plugins.network })
      .from(plugins)
      .where(eq(plugins.id, row.pluginId));
    await runner.client.launchMcp(row.id, {
      packageId: row.pluginId,
      command: row.command,
      cwd: row.cwd,
      env: await this.deps.secrets.resolve(row.env),
      network: plugin?.network ?? 'none',
    });
  }

  /** Disconnects the server's current client. */
  private async retire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    await entry?.client.disconnect().catch(() => {});
  }

  /** A secret changed: servers using it get a new client (new headers or environment). */
  private async secretChanged(name: string): Promise<void> {
    for (const row of [...this.rows.values()]) {
      if (![...secretNames(row.headers), ...secretNames(row.env)].includes(name)) continue;
      await this.lock
        .run(async () => {
          const [next] = await this.deps.db
            .update(mcpServers)
            .set({ revision: row.revision + 1, updatedAt: new Date() })
            .where(eq(mcpServers.id, row.id))
            .returning();
          this.rows.set(row.id, next as McpServerRow);
          await this.retire(row.id);
          await this.hydrate(next as McpServerRow);
          if (row.transport === 'stdio') await this.launch(next as McpServerRow);
        })
        .catch((error: unknown) =>
          this.logger.warn('Could not apply a rotated secret', { server: row.slug, error }),
        );
    }
  }

  private notify(slugs: string[]): void {
    for (const listener of this.listeners) listener(slugs);
  }

  private stored(definition: SerializableMCPToolDefinition): McpToolDefinition {
    // The server's instructions never reach a model (it could be anyone's server).
    return {
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      inputSchema: (definition.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      ...(definition.outputSchema
        ? { outputSchema: definition.outputSchema as Record<string, unknown> }
        : {}),
      ...(definition.annotations ? { annotations: definition.annotations as Record<string, unknown> } : {}),
    };
  }

  private checkUrl(raw: string, allowPrivate: boolean): URL {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ApiError(400, 'invalid_url', 'MCP servers are reached over http(s)');
    }
    if (url.protocol === 'http:' && !allowPrivate) {
      throw new ApiError(400, 'insecure_url', 'Use https (plain http only for private-network servers)');
    }
    return url;
  }

  private async requireSecrets(names: string[]): Promise<void> {
    const missing = await this.deps.secrets.missing(names);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        'secret_missing',
        `No secret named ${missing.join(', ')} (PUT /v1/secrets/{name})`,
      );
    }
  }

  private row(id: string): McpServerRow {
    const row = this.rows.get(id);
    if (!row) throw new ApiError(404, 'mcp_server_not_found', 'No MCP server with this id');
    return row;
  }

  private present(row: McpServerRow): McpServer {
    const keys = mcpToolKeys(
      row.slug,
      row.tools.map((tool) => tool.name),
    );
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      plugin: row.pluginId ? (this.pluginNames.get(row.pluginId) ?? null) : null,
      transport: row.transport,
      url: row.url,
      headers: row.headers,
      allowPrivateNetwork: row.allowPrivateNetwork,
      command: row.command,
      package: row.package,
      env: row.env,
      enabled: row.enabled,
      status: row.status,
      statusDetail: row.statusDetail,
      tools: row.tools.map((tool) => ({
        name: tool.name,
        key: keys.get(tool.name) ?? tool.name,
        description: tool.description ?? tool.title ?? '',
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
      toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export { BlockedUrlError };
