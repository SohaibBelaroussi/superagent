import { randomUUID } from 'node:crypto';
import type { ToolsInput } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import { createTool, type Tool } from '@mastra/core/tools';
import { MCPClient, type SerializableMCPToolDefinition } from '@mastra/mcp';
import type { CreateMcpServerInput, McpGrant, McpServer, UpdateMcpServerInput } from '@superagent/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { type McpServerRow, type McpToolDefinition, mcpServers, plugins } from '../../../db/schema';
import { ApiError } from '../../../http/problem';
import { Mutex } from '../../../util/mutex';
import { errorText, withoutStack } from '../../../util/text';
import { assertPublicUrl, type ResolveHost } from '../../tools/web';
import type { RunnerClient } from '../../workspace/runner-client';
import { type SecretService, secretNames } from '../secrets';
import { mcpToolKeys, RESERVED_SLUGS } from './naming';

/** What a tool result may weigh when it reaches the model (like fetch_page's pages). */
const MAX_RESULT_CHARS = 50_000;
/** What a remote server's answer to one request may weigh before it is cut off. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A tool whose input schema is bigger than this is not offered (it would flood every prompt). */
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_REDIRECTS = 5;
/** A stdio server's first call may wait for its container to start. */
const STDIO_CONNECT_MS = 120_000;
const HTTP_CONNECT_MS = 30_000;

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
export function redacting(logger: IMastraLogger): IMastraLogger {
  const scrub = (data: unknown) => {
    if (!data || typeof data !== 'object') return data;
    const { toolArgs: _args, args: _a, arguments: _b, result: _r, ...rest } = data as Record<string, unknown>;
    return rest;
  };
  return new Proxy(logger, {
    get(target, prop) {
      if (prop === 'debug' || prop === 'info' || prop === 'warn' || prop === 'error') {
        return (message: string, ...rest: unknown[]) =>
          (target[prop] as (m: string, ...r: unknown[]) => void)(message, ...rest.map(scrub));
      }
      // A child logger redacts too.
      if (prop === 'child' && typeof (target as { child?: unknown }).child === 'function') {
        return (...args: unknown[]) =>
          redacting((target as unknown as { child: (...a: unknown[]) => IMastraLogger }).child(...args));
      }
      // Read and called on the logger itself: it uses private fields, which a proxy doesn't have.
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Whether a call failed because the server forgot its session (it restarted, or was stopped idle):
 * an HTTP 404 from the transport, which means the call never reached the server. A tool's own error
 * (whatever its text says) never counts: retrying it would run the tool twice.
 */
export function lostSession(error: unknown): boolean {
  let status = false;
  for (
    let e = error as Record<string, unknown> | undefined, i = 0;
    e && typeof e === 'object' && i < 6;
    i++
  ) {
    if (e.id === 'MCP_CLIENT_TOOL_EXECUTION_FAILED') return false;
    if (e.status === 404 || e.statusCode === 404) status = true;
    e = e.cause as Record<string, unknown> | undefined;
  }
  return status;
}

/** Long results are cut before they reach the model. */
function capped(result: unknown): unknown {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (text === undefined || text.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, content: `${text.slice(0, MAX_RESULT_CHARS)}…` };
}

/** A response whose body errors once it passes `max` bytes (the client sees a failed request). */
function limited(response: Response, max: number): Response {
  if (!response.body) return response;
  let seen = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('The MCP server answered with too much data'));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * MCP servers (decision D36): one @mastra/mcp client per server revision, tools discovered once and
 * kept in our table, and wrapper tools per grant (our names, the grant's allowlist and approvals).
 * HTTP servers reach public addresses only, unless the owner marked them private-network; stdio
 * servers run in the runner's containers, which relay their stdio as Streamable HTTP. Network I/O
 * never happens under the lock: discovery runs outside it, and its result is kept only if the server
 * didn't change (or go) meanwhile.
 */
export class McpService {
  private readonly rows = new Map<string, McpServerRow>();
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(slugs: string[]) => void>();
  private readonly lock = new Mutex();
  private readonly pluginNames = new Map<string, string>();
  /** Plugins whose servers were forgotten (uninstalled): their rows never come back. */
  private readonly gone = new Set<string>();
  private readonly logger: IMastraLogger;

  constructor(private readonly deps: McpDeps) {
    this.logger = redacting(deps.logger);
    deps.secrets.onChange((name) => void this.secretChanged(name));
  }

  /** Called with the slugs of servers whose tools changed: agents granting them are rebuilt. */
  onToolsChanged(listener: (slugs: string[]) => void): void {
    this.listeners.add(listener);
  }

  /** Reads every server and builds its client; one that can't be built is marked, never fatal. */
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
      if (RESERVED_SLUGS.has(input.slug)) {
        throw new ApiError(
          400,
          'reserved_slug',
          `"${input.slug}" is the first word of built-in tools: pick another slug`,
        );
      }
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
      const created = row as McpServerRow;
      this.rows.set(created.id, created);
      await this.hydrate(created);
      return created.id;
    });
    return this.refresh(id).catch(() => this.get(id));
  }

  /** Rows a plugin install wrote: track them (their tools come from refresh). */
  adopt(rows: McpServerRow[], pluginName: string): void {
    for (const row of rows) {
      if (row.pluginId && this.gone.has(row.pluginId)) continue;
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
        row.transport === 'http'
          ? this.checkUrl(input.url ?? (row.url as string), allowPrivate).toString()
          : null;
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
      const saved = this.keep(id, next);
      if (!saved) throw new ApiError(404, 'mcp_server_not_found', 'No MCP server with this id');
      this.retire(id);
      await this.hydrate(saved);
      // A stdio server's process runs with its launch: it learns the new one, or stops when disabled.
      if (saved.transport === 'stdio') await this.relaunch(saved);
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
      this.retire(id);
      this.rows.delete(id);
    });
  }

  /** Forgets a plugin's servers before its rows are deleted: nothing of them may come back. */
  forgetPlugin(pluginId: string): Promise<string[]> {
    return this.lock.run(async () => {
      this.gone.add(pluginId);
      const forgotten = this.ofPlugin(pluginId);
      for (const row of forgotten) {
        this.retire(row.id);
        this.rows.delete(row.id);
      }
      this.pluginNames.delete(pluginId);
      return forgotten.map((row) => row.slug);
    });
  }

  /** Records that a server could not be set up (its plugin's install), where the owner sees it. */
  fail(id: string, detail: string): Promise<void> {
    return this.lock.run(async () => {
      if (!this.rows.has(id)) return;
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({ status: 'failed', statusDetail: withoutStack(detail).slice(0, 1000), updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning();
      this.keep(id, next);
    });
  }

  /** A package-run server's command, once its package is installed (its plugin's setup). */
  installed(id: string, command: string[], pkg: string): Promise<void> {
    return this.lock.run(async () => {
      if (!this.rows.has(id)) return;
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({ command, package: pkg, updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning();
      this.keep(id, next);
    });
  }

  /** Asks the server for its tools and keeps them. The server's status says how it went. */
  async refresh(id: string): Promise<McpServer> {
    const { row, entry } = await this.lock.run(async () => {
      const row = this.row(id);
      if (!row.enabled) throw new ApiError(409, 'mcp_server_disabled', 'Enable the server first');
      return { row, entry: this.entries.get(id) ?? (await this.hydrate(row)) };
    });
    if (!entry) return this.get(id);
    let update: Partial<McpServerRow>;
    try {
      const { definitions, errors } = await entry.client.listToolDefinitionsWithErrors();
      const found = definitions[row.slug];
      if (!found) throw new Error(errors[row.slug] ?? 'The server listed no tools');
      update = {
        status: 'ready',
        statusDetail: null,
        tools: Object.values(found).flatMap((definition) => this.stored(row.slug, definition)),
        toolsRefreshedAt: new Date(),
      };
    } catch (error) {
      update = { status: 'failed', statusDetail: errorText(error).slice(0, 500) };
      this.logger.warn('MCP server discovery failed', { server: row.slug, error: update.statusDetail });
    }
    const changed = await this.lock.run(async () => {
      const current = this.rows.get(id);
      // Changed or gone while it was asked: its answer is for an old version.
      if (!current || current.revision !== row.revision || this.entries.get(id) !== entry) return false;
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({ ...update, updatedAt: new Date() })
        .where(and(eq(mcpServers.id, id), eq(mcpServers.revision, row.revision)))
        .returning();
      const saved = this.keep(id, next);
      if (!saved) return false;
      // The client stays; only the tools it serves are rebuilt.
      await this.hydrateTools(saved, entry);
      return JSON.stringify(saved.tools) !== JSON.stringify(current.tools);
    });
    if (changed) this.notify([row.slug]);
    return this.get(id);
  }

  /** The wrapper tools a set of grants gives: the granted tools of enabled servers, with our names. */
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

  /** Tells the runner how to start a stdio server (secrets resolved now, kept in its memory only). */
  async launch(row: McpServerRow): Promise<void> {
    const runner = this.deps.runner;
    if (!runner || row.transport !== 'stdio') return;
    if (!row.pluginId || this.gone.has(row.pluginId)) throw new Error('Its plugin is uninstalled');
    if (!row.command) throw new Error("Its package isn't installed yet");
    const [plugin] = await this.deps.db
      .select({ network: plugins.network })
      .from(plugins)
      .where(eq(plugins.id, row.pluginId));
    if (!plugin) throw new Error('Its plugin is uninstalled');
    await runner.client.launchMcp(row.id, {
      packageId: row.pluginId,
      command: row.command,
      cwd: row.cwd,
      env: await this.deps.secrets.resolve(row.env),
      network: plugin.network,
    });
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.client.disconnect()));
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
      // The call never reached the server: reconnect and send it once more.
      await entry.client.reconnectServer(row.slug);
      return capped(await run());
    }
  }

  // --- clients ---

  /**
   * Builds the server's client for its current revision and rebuilds its tools (no connection yet).
   * A server whose secrets are missing gets no client: it is marked failed instead.
   */
  private async hydrate(row: McpServerRow): Promise<Entry | undefined> {
    let definition: Awaited<ReturnType<McpService['definition']>>;
    try {
      definition = await this.definition(row);
    } catch (error) {
      this.entries.delete(row.id);
      const detail = `It can't connect: ${errorText(error)}`;
      this.logger.warn('An MCP server cannot be used', { server: row.slug, error: detail });
      const [next] = await this.deps.db
        .update(mcpServers)
        .set({ status: 'failed', statusDetail: detail.slice(0, 500), updatedAt: new Date() })
        .where(eq(mcpServers.id, row.id))
        .returning()
        .catch(() => []);
      this.keep(row.id, next);
      return undefined;
    }
    const entry: Entry = {
      revision: row.revision,
      client: new MCPClient({
        id: `mcp:${row.id}:${row.revision}`,
        servers: { [row.slug]: definition },
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
        if (response.status < 300 || response.status >= 400) {
          // Answers to calls are bounded; the server's long-lived event stream (GET) is not.
          return (init?.method ?? 'GET').toUpperCase() === 'POST'
            ? limited(response, MAX_RESPONSE_BYTES)
            : response;
        }
        const location = response.headers.get('location');
        if (!location) return response;
        await response.body?.cancel();
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

  /** A stdio server's new launch reaches the runner; a disabled one's process is stopped. */
  private async relaunch(row: McpServerRow): Promise<void> {
    const runner = this.deps.runner;
    if (!runner) return;
    try {
      if (row.enabled && row.command) await this.launch(row);
      else await runner.client.forgetMcp(row.id);
    } catch (error) {
      this.logger.warn('Could not update a stdio server in the runner', { server: row.slug, error });
    }
  }

  /** Disconnects the server's current client, without waiting for it. */
  private retire(id: string): void {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    void entry?.client.disconnect().catch(() => {});
  }

  /** Keeps a row the database returned, or forgets one that is gone (never stores nothing). */
  private keep(id: string, next: McpServerRow | undefined): McpServerRow | undefined {
    if (!next) {
      this.retire(id);
      this.rows.delete(id);
      return undefined;
    }
    this.rows.set(id, next);
    return next;
  }

  /** A secret changed: servers using it get a new client (new headers or environment). */
  private async secretChanged(name: string): Promise<void> {
    const users = [...this.rows.values()].filter((row) =>
      [...secretNames(row.headers), ...secretNames(row.env)].includes(name),
    );
    for (const user of users) {
      await this.lock
        .run(async () => {
          const row = this.rows.get(user.id);
          if (!row) return;
          const [next] = await this.deps.db
            .update(mcpServers)
            .set({ revision: row.revision + 1, updatedAt: new Date() })
            .where(eq(mcpServers.id, row.id))
            .returning();
          const saved = this.keep(row.id, next);
          if (!saved) return;
          this.retire(row.id);
          await this.hydrate(saved);
          if (saved.transport === 'stdio') await this.relaunch(saved);
        })
        .catch((error: unknown) =>
          this.logger.warn('Could not apply a rotated secret', { server: user.slug, error }),
        );
    }
  }

  private notify(slugs: string[]): void {
    for (const listener of this.listeners) listener(slugs);
  }

  private stored(slug: string, definition: SerializableMCPToolDefinition): McpToolDefinition[] {
    const inputSchema = (definition.inputSchema ?? { type: 'object' }) as Record<string, unknown>;
    if (JSON.stringify(inputSchema).length > MAX_SCHEMA_CHARS) {
      this.logger.warn('An MCP tool was left out: its input schema is too large', {
        server: slug,
        tool: definition.name,
      });
      return [];
    }
    // The server's instructions never reach a model (it could be anyone's server).
    return [
      {
        name: definition.name,
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description ? { description: definition.description.slice(0, 4096) } : {}),
        inputSchema,
        ...(definition.outputSchema
          ? { outputSchema: definition.outputSchema as Record<string, unknown> }
          : {}),
        ...(definition.annotations ? { annotations: definition.annotations as Record<string, unknown> } : {}),
      },
    ];
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
