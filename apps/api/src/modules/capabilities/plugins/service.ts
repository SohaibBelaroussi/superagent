import { createHash, randomUUID } from 'node:crypto';
import type { IMastraLogger } from '@mastra/core/logger';
import type {
  ConfigValue,
  InstallPluginInput,
  Plugin,
  PluginPreview,
  PluginSource,
} from '@superagent/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { isUniqueViolation } from '../../../db/errors';
import {
  type McpServerRow,
  mcpServers,
  type PluginRow,
  pluginFiles,
  plugins,
  secrets,
  skills,
} from '../../../db/schema';
import { ApiError } from '../../../http/problem';
import { Mutex } from '../../../util/mutex';
import { errorText } from '../../../util/text';
import type { RunnerClient } from '../../workspace/runner-client';
import { mcpToolKeys } from '../mcp/naming';
import type { McpService } from '../mcp/service';
import { type SecretService, secretNames } from '../secrets';
import type { SkillStore } from '../skills';
import { ARCHIVE_LIMITS, type PluginFetcher, type PluginFile } from './fetch';
import { type PlannedServer, type PluginPlan, placeholders, planPlugin, render, serverSlug } from './formats';
import { writeTar } from './tar';

const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_PREVIEWS = 4;
/** Manifests read before the archive, so its stream can keep only the plugin's files. */
const MANIFESTS = [
  'plugin.json',
  'mcp.json',
  '.mcp.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
];
const INTERRUPTED = 'Its setup was interrupted by a restart: uninstall it and install it again';

interface Preview {
  id: string;
  expiresAt: number;
  source: PluginSource;
  sha: string | null;
  plan: PluginPlan;
  files: Map<string, PluginFile>;
  bytes: number;
}

/** A plugin's background setup: an uninstall stops it, then waits for it. */
interface Setup {
  abort: AbortController;
  done: Promise<void>;
}

export interface PluginDeps {
  db: Db;
  fetcher: PluginFetcher;
  secrets: SecretService;
  skills: SkillStore;
  mcp: McpService;
  runner?: RunnerClient;
  /** Removes a plugin's skills and servers from agents (new versions) and departments. */
  detach: (plugin: string, slugs: string[]) => Promise<void>;
  /** The tool names of calls waiting for the owner's approval. */
  pendingApprovals: () => Promise<string[]>;
  logger: IMastraLogger;
}

/** The repository's name, as a plugin name for packages that have no manifest. */
function fallbackName(source: PluginSource): string | undefined {
  const raw =
    source.kind === 'github' ? (source.path?.split('/').pop() ?? source.repo.split('/')[1]) : undefined;
  const name = raw
    ?.toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return name || undefined;
}

/**
 * The name of a secret a plugin's install creates: readable, and unique to that install (a hash of
 * its id and the value's place), so no plugin can ever take or replace another's.
 */
export function pluginSecretName(
  pluginId: string,
  plugin: string,
  server: string,
  kind: string,
  name: string,
): string {
  const hash = createHash('sha256')
    .update(`${pluginId}/${server}/${kind}/${name}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  let base = `${plugin}_${server}_${kind}_${name}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_');
  if (!/^[A-Z]/.test(base)) base = `P_${base}`;
  return `${base.slice(0, 55).replace(/_+$/, '')}_${hash}`;
}

/**
 * Plugins (decision D38): previewed from a pinned source, then installed into owned rows: their
 * files, skills, MCP servers and the secrets their inputs became. stdio servers are set up in the
 * background (files and packages into the runner's volume, then tool discovery). Uninstalling stops
 * that setup, detaches them from agents and departments and removes all of it.
 */
export class PluginService {
  private readonly previews = new Map<string, Preview>();
  private readonly lock = new Mutex();
  private readonly setups = new Map<string, Setup>();

  constructor(private readonly deps: PluginDeps) {}

  async preview(source: PluginSource): Promise<PluginPreview> {
    this.expire();
    const { files, sha, refused } = await this.fetch(source);
    const plan = planPlugin(files, {
      takenSlugs: new Set(this.deps.mcp.list().map((server) => server.slug)),
      fallbackName: fallbackName(source),
    });
    if (refused.length > 0) {
      const shown = refused.slice(0, 10).join(', ');
      plan.warnings.push(
        `Left out (links and other entries that are not regular files): ${shown}${refused.length > 10 ? ` and ${refused.length - 10} more` : ''}`,
      );
    }
    if (this.previews.size >= MAX_PREVIEWS) {
      const oldest = [...this.previews.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.previews.delete(oldest.id);
    }
    const bytes = [...files.values()].reduce((sum, file) => sum + file.data.length, 0);
    const preview: Preview = {
      id: randomUUID(),
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      source,
      sha,
      plan,
      files,
      bytes,
    };
    this.previews.set(preview.id, preview);
    return this.presentPreview(preview, await this.byName(plan.name));
  }

  async install(input: InstallPluginInput): Promise<Plugin> {
    this.expire();
    const preview = this.previews.get(input.previewId);
    if (!preview)
      throw new ApiError(404, 'preview_not_found', 'No such preview (they last 30 minutes): preview again');
    const { plan } = preview;
    // The values given, else the plugin's defaults.
    const values: Record<string, string> = {
      ...Object.fromEntries(plan.inputs.flatMap((i) => (i.default !== null ? [[i.name, i.default]] : []))),
      ...(input.inputs ?? {}),
    };
    const missing = plan.inputs.filter((i) => i.required && !values[i.name]).map((i) => i.name);
    if (missing.length > 0) {
      throw new ApiError(400, 'inputs_missing', `This plugin needs: ${missing.join(', ')}`);
    }
    const plugin = await this.lock.run(async () => {
      if (await this.byName(plan.name)) {
        throw new ApiError(
          409,
          'plugin_exists',
          `A plugin named "${plan.name}" is installed: uninstall it first`,
        );
      }
      const id = randomUUID();
      const servers = plan.servers.filter((server) => input.servers?.[server.key]?.enabled !== false);
      // The secrets the owner named for its servers exist before anything is written.
      const named = servers.flatMap((server) => {
        const extra = input.servers?.[server.key];
        return [...secretNames(extra?.env), ...secretNames(extra?.headers)];
      });
      const absent = await this.deps.secrets.missing(named);
      if (absent.length > 0) {
        throw new ApiError(
          400,
          'secret_missing',
          `No secret named ${absent.join(', ')} (PUT /v1/secrets/{name})`,
        );
      }
      // A slug taken since the preview: that server gets another.
      const taken = new Set(this.deps.mcp.list().map((server) => server.slug));
      const secretRows: Array<typeof secrets.$inferInsert> = [];
      const args = new Map<string, string[]>();
      const serverRows = servers.map((server) => {
        const slug = taken.has(server.slug) ? serverSlug(plan.name, server.key, taken) : server.slug;
        taken.add(slug);
        const extra = input.servers?.[server.key];
        const env = this.values(id, plan, server, server.env, values, secretRows, 'ENV');
        const headers = this.values(id, plan, server, server.headers, values, secretRows, 'HEADER');
        const command = server.command.map((arg) => this.fill(plan, arg, values));
        args.set(server.key, command);
        return {
          id: randomUUID(),
          slug,
          name: `${plan.title}: ${server.key}`,
          description: `MCP server ${server.key} of the ${plan.name} plugin`,
          pluginId: id,
          key: server.key,
          transport: server.transport,
          url: server.url ? this.url(plan, server, values) : null,
          headers: { ...headers, ...(extra?.headers ?? {}) },
          runtime: server.runtime,
          package: server.package ? `${server.package}@${server.version}` : null,
          // A package's executable is known once it is installed (setup).
          command: server.transport === 'stdio' && server.runtime === 'bundled' ? command : null,
          cwd: server.cwd,
          env: { ...env, ...(extra?.env ?? {}) },
          status: 'pending' as const,
        };
      });
      const rows: McpServerRow[] = [];
      try {
        await this.deps.db.transaction(async (tx) => {
          await tx.insert(plugins).values({
            id,
            name: plan.name,
            title: plan.title,
            version: plan.version,
            description: plan.description,
            format: plan.format,
            source: preview.source as Record<string, unknown>,
            sha: preview.sha,
            license: plan.license,
            status: servers.length > 0 ? 'installing' : 'installed',
            network: input.network ?? 'egress',
            warnings: [...plan.warnings, ...plan.skipped.map((s) => `${s.component}: ${s.reason}`)],
          });
          const fileRows = [...preview.files.entries()].map(([path, file]) => ({
            pluginId: id,
            path,
            mode: file.mode,
            size: file.data.length,
            sha256: createHash('sha256').update(file.data).digest('hex'),
            content: file.data,
          }));
          for (let i = 0; i < fileRows.length; i += 200)
            await tx.insert(pluginFiles).values(fileRows.slice(i, i + 200));
          if (plan.skills.length > 0) {
            await tx.insert(skills).values(
              plan.skills.map((skill) => ({
                id: randomUUID(),
                pluginId: id,
                name: skill.name,
                description: skill.description,
                dir: skill.dir,
                license: skill.license,
                compatibility: skill.compatibility,
                fileCount: skill.files,
                sizeBytes: skill.bytes,
              })),
            );
          }
          // Its secrets are new ones, written with it: never another's, never replaced.
          if (secretRows.length > 0) await tx.insert(secrets).values(secretRows);
          for (const row of serverRows) {
            const [inserted] = await tx.insert(mcpServers).values(row).returning();
            rows.push(inserted as McpServerRow);
          }
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            'plugin_conflict',
            'A server slug or secret this plugin needs was taken meanwhile: preview it again',
          );
        }
        throw error;
      }
      await this.deps.skills.load();
      this.deps.mcp.adopt(rows, plan.name);
      this.previews.delete(preview.id);
      this.deps.logger.info('Plugin installed', {
        plugin: plan.name,
        skills: plan.skills.length,
        servers: rows.length,
      });
      if (rows.length > 0) this.start(id, plan.name, rows, preview.files, plan, args);
      return id;
    });
    return this.get(plugin);
  }

  async list(): Promise<Plugin[]> {
    const rows = await this.deps.db.select().from(plugins).orderBy(plugins.name);
    return rows.map((row) => this.present(row));
  }

  async get(id: string): Promise<Plugin> {
    const [row] = await this.deps.db.select().from(plugins).where(eq(plugins.id, id));
    if (!row) throw new ApiError(404, 'plugin_not_found', 'No plugin with this id');
    return this.present(row);
  }

  /**
   * Removes a plugin and everything it brought: its setup stops, its skills and servers leave the
   * agents (a new version of each) and departments that had them, its containers and volumes go, then
   * its rows and the secrets nothing else uses.
   */
  async uninstall(id: string): Promise<void> {
    await this.lock.run(async () => {
      const [row] = await this.deps.db.select().from(plugins).where(eq(plugins.id, id));
      if (!row) throw new ApiError(404, 'plugin_not_found', 'No plugin with this id');
      const servers = this.deps.mcp.ofPlugin(id);
      const tools = new Set(
        servers.flatMap((server) => [
          ...mcpToolKeys(
            server.slug,
            server.tools.map((tool) => tool.name),
          ).values(),
        ]),
      );
      const waiting = (await this.deps.pendingApprovals()).filter((tool) => tools.has(tool));
      if (waiting.length > 0) {
        throw new ApiError(
          409,
          'approvals_pending',
          `Calls to its tools wait for your approval (${waiting.join(', ')}): decide them first`,
        );
      }
      await this.deps.detach(
        row.name,
        servers.map((server) => server.slug),
      );
      // Its setup stops, and nothing of it may come back (the runner refuses the package from now on).
      const setup = this.setups.get(id);
      setup?.abort.abort();
      await this.deps.mcp.forgetPlugin(id);
      if (servers.some((server) => server.transport === 'stdio')) {
        await this.deps.runner?.removeMcp(id, true).catch((error: unknown) => {
          this.deps.logger.warn("Could not remove a plugin's MCP container", { plugin: row.name, error });
        });
      }
      await setup?.done;
      const kept = await this.deps.secrets.release(id);
      if (kept.length > 0) {
        this.deps.logger.info("A plugin's secrets other servers use were kept", { plugin: row.name, kept });
      }
      await this.deps.db.delete(plugins).where(eq(plugins.id, id));
      await this.deps.skills.load();
      this.deps.logger.info('Plugin uninstalled', { plugin: row.name });
    });
  }

  /**
   * At boot: setups a restart interrupted can't resume (their files and values are gone), so their
   * plugins and waiting servers are marked failed, where the owner sees them.
   */
  async recover(): Promise<void> {
    const stuck = await this.deps.db
      .select({ id: plugins.id, name: plugins.name })
      .from(plugins)
      .where(eq(plugins.status, 'installing'));
    for (const plugin of stuck) {
      await this.deps.db
        .update(plugins)
        .set({ status: 'failed', statusDetail: INTERRUPTED, updatedAt: new Date() })
        .where(eq(plugins.id, plugin.id));
      for (const server of this.deps.mcp.ofPlugin(plugin.id)) {
        if (server.status === 'pending') await this.deps.mcp.fail(server.id, INTERRUPTED);
      }
      this.deps.logger.warn('A plugin setup was interrupted by a restart', { plugin: plugin.name });
    }
  }

  /**
   * Removes what the runner keeps for plugins that are gone (an uninstall that couldn't reach it, or
   * a crash in the middle of one): containers, launches and volumes.
   */
  async reconcile(): Promise<void> {
    const runner = this.deps.runner;
    if (!runner) return;
    await this.lock.run(async () => {
      const installed = new Set(
        (await this.deps.db.select({ id: plugins.id }).from(plugins)).map((row) => row.id),
      );
      for (const leftover of await runner.listMcp()) {
        if (installed.has(leftover.packageId)) continue;
        await runner.removeMcp(leftover.packageId, true);
        this.deps.logger.info("Removed an uninstalled plugin's MCP leftovers", {
          packageId: leftover.packageId,
        });
      }
    });
  }

  /** Waits for background setups (shutdown and tests). */
  async settled(): Promise<void> {
    while (this.setups.size > 0) await Promise.allSettled([...this.setups.values()].map((s) => s.done));
  }

  // --- install helpers ---

  /**
   * A server's environment or headers. Agent Plugins packages take no values: their text is used as
   * is. Otherwise a value made from install inputs is kept in the vault, owned by the plugin, and the
   * others are plain.
   */
  private values(
    pluginId: string,
    plan: PluginPlan,
    server: PlannedServer,
    templates: Record<string, string>,
    inputs: Record<string, string>,
    secretRows: Array<typeof secrets.$inferInsert>,
    kind: 'ENV' | 'HEADER',
  ): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {};
    const names = new Set(plan.inputs.map((i) => i.name));
    for (const [name, template] of Object.entries(templates)) {
      if (plan.format === 'agent-plugins' || !placeholders(template).some((p) => names.has(p))) {
        out[name] = { value: this.fill(plan, template, inputs) };
        continue;
      }
      const secret = pluginSecretName(pluginId, plan.name, server.key, kind, name);
      secretRows.push(
        this.deps.secrets.sealed(
          secret,
          render(template, inputs, names),
          `For the ${plan.name} plugin (${server.key})`,
          pluginId,
        ),
      );
      out[name] = { secret };
    }
    return out;
  }

  /** A value with the install's inputs filled in (Agent Plugins packages take none). */
  private fill(plan: PluginPlan, template: string, inputs: Record<string, string>): string {
    if (plan.format === 'agent-plugins') return template;
    return render(template, inputs, new Set(plan.inputs.map((i) => i.name)));
  }

  /** A remote server's URL, filled in: still https. */
  private url(plan: PluginPlan, server: PlannedServer, inputs: Record<string, string>): string {
    const filled = this.fill(plan, server.url as string, inputs);
    let url: URL | undefined;
    try {
      url = new URL(filled);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:') {
      throw new ApiError(
        400,
        'invalid_input',
        `The ${server.key} server's URL is not an https URL once filled in`,
      );
    }
    return url.toString();
  }

  private start(
    id: string,
    name: string,
    rows: McpServerRow[],
    files: Map<string, PluginFile>,
    plan: PluginPlan,
    args: Map<string, string[]>,
  ): void {
    const abort = new AbortController();
    const done: Promise<void> = this.setUp(id, name, rows, files, plan, args, abort.signal)
      .catch((error: unknown) => this.deps.logger.error('Plugin setup failed', { plugin: name, error }))
      .finally(() => {
        if (this.setups.get(id)?.done === done) this.setups.delete(id);
      });
    this.setups.set(id, { abort, done });
  }

  /**
   * Puts a plugin's stdio servers in place (files, then each server's package), then asks every
   * server for its tools. Stops as soon as the plugin is uninstalled.
   */
  private async setUp(
    id: string,
    name: string,
    rows: McpServerRow[],
    files: Map<string, PluginFile>,
    plan: PluginPlan,
    args: Map<string, string[]>,
    signal: AbortSignal,
  ): Promise<void> {
    const problems: string[] = [];
    let ready = rows;
    const stdio = rows.filter((row) => row.transport === 'stdio');
    if (stdio.length > 0) {
      const runner = this.deps.runner;
      if (!runner) {
        problems.push('stdio servers need the runner (RUNNER_URL and RUNNER_TOKEN)');
        ready = rows.filter((row) => row.transport === 'http');
        for (const row of stdio) await this.deps.mcp.fail(row.id, 'stdio servers need the runner');
      } else {
        try {
          // The plugin's files, without its skills (agents read those from the database).
          const skillDirs = plan.skills.map((skill) => `${skill.dir}/`);
          const kept = [...files.entries()]
            .filter(([path]) => !skillDirs.some((dir) => path.startsWith(dir)))
            .map(([path, file]) => ({ path, mode: file.mode, data: file.data }));
          await runner.mcpFiles(id, writeTar(kept), signal);
          const planned = new Map(plan.servers.map((server) => [server.key, server]));
          // One request per server: each install may take up to the runner's install timeout.
          for (const row of stdio.filter((r) => r.runtime === 'npm' || r.runtime === 'uv')) {
            signal.throwIfAborted();
            const server = planned.get(row.key ?? '') as PlannedServer;
            const result = await runner.mcpInstall(
              id,
              {
                servers: [
                  {
                    key: server.key,
                    runtime: row.runtime as 'npm' | 'uv',
                    package: server.package as string,
                    version: server.version as string,
                    ...(server.bin ? { bin: server.bin } : {}),
                  },
                ],
              },
              signal,
            );
            const installed = result.servers[0];
            if (!installed?.ok || !installed.executable) {
              const log = installed?.log ?? '';
              problems.push(`${row.slug}: install failed (${log.slice(-300)})`);
              ready = ready.filter((r) => r.id !== row.id);
              await this.deps.mcp.fail(row.id, `Its package did not install: ${log.slice(-500)}`);
              continue;
            }
            const rest = args.get(server.key) ?? [];
            await this.deps.mcp.installed(
              row.id,
              row.runtime === 'npm'
                ? ['node', installed.executable, ...rest]
                : [installed.executable, ...rest],
              `${server.package}@${installed.version ?? server.version}`,
            );
          }
        } catch (error) {
          if (signal.aborted) return;
          problems.push(`setting up its stdio servers failed: ${errorText(error)}`);
          ready = rows.filter((row) => row.transport === 'http');
          for (const row of stdio) await this.deps.mcp.fail(row.id, errorText(error));
        }
      }
    }
    for (const row of ready) {
      if (signal.aborted) return;
      try {
        const current = this.deps.mcp.ofPlugin(id).find((r) => r.id === row.id);
        if (!current) continue;
        if (current.transport === 'stdio') await this.deps.mcp.launch(current);
        const server = await this.deps.mcp.refresh(row.id);
        if (server.status !== 'ready') problems.push(`${server.slug}: ${server.statusDetail ?? 'no tools'}`);
      } catch (error) {
        if (signal.aborted) return;
        problems.push(`${row.slug}: ${errorText(error)}`);
        await this.deps.mcp.fail(row.id, errorText(error));
      }
    }
    if (signal.aborted) return;
    await this.deps.db
      .update(plugins)
      .set({
        status: problems.length > 0 ? 'failed' : 'installed',
        statusDetail: problems.length > 0 ? problems.join('; ').slice(0, 2000) : null,
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, id))
      .catch(() => {});
    if (problems.length > 0)
      this.deps.logger.warn('A plugin was installed with problems', { plugin: name, problems });
  }

  // --- fetching ---

  private async fetch(
    source: PluginSource,
  ): Promise<{ files: Map<string, PluginFile>; sha: string | null; refused: string[] }> {
    const { fetcher } = this.deps;
    if (source.kind === 'url') {
      const unpacked = await fetcher.unpack(
        source.url,
        { stripTop: false, root: null, keep: null, limits: ARCHIVE_LIMITS },
        { allowPrivate: source.allowPrivateNetwork },
      );
      if (unpacked.sha256 !== source.sha256) {
        throw new ApiError(
          422,
          'checksum_mismatch',
          `The archive's sha256 is ${unpacked.sha256}, not the one given`,
        );
      }
      return { files: unpacked.files, sha: null, refused: unpacked.refused };
    }
    const sha = await fetcher.resolveSha(source.repo, source.ref ?? 'HEAD');
    const prefix = source.path ? `${source.path.replace(/\/+$/, '')}/` : '';
    const probed = new Map<string, PluginFile>();
    for (const manifest of MANIFESTS) {
      const data = await fetcher.readRaw(source.repo, sha, `${prefix}${manifest}`);
      if (data) probed.set(manifest, { mode: 0o644, data });
    }
    const unpacked = await fetcher.unpack(`https://api.github.com/repos/${source.repo}/tarball/${sha}`, {
      stripTop: true,
      root: source.path ? source.path.replace(/\/+$/, '') : null,
      keep: this.keepFor(probed),
      limits: ARCHIVE_LIMITS,
    });
    if (unpacked.comment !== sha) {
      throw new ApiError(422, 'plugin_unavailable', 'The archive GitHub sent is not the pinned commit');
    }
    return { files: unpacked.files, sha, refused: unpacked.refused };
  }

  /**
   * What to keep of a repository's archive: its manifests and skills, or the whole plugin when it has
   * MCP servers of its own (their code may sit anywhere, and a manifest may name a config file).
   */
  private keepFor(probed: Map<string, PluginFile>): string[] | null {
    const keep = new Set([
      ...MANIFESTS,
      '.codex-plugin/',
      '.claude-plugin/',
      'skills/',
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
    ]);
    try {
      const plan = planPlugin(probed, { fallbackName: 'probe' });
      if (plan.servers.some((server) => server.runtime === 'bundled')) return null;
      for (const manifest of [
        probed.get('.codex-plugin/plugin.json'),
        probed.get('.claude-plugin/plugin.json'),
      ]) {
        if (!manifest) continue;
        const parsed = JSON.parse(manifest.data.toString('utf8')) as {
          skills?: unknown;
          mcpServers?: unknown;
        };
        const configs = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [parsed.mcpServers];
        if (configs.some((config) => typeof config === 'string')) return null;
        for (const path of Array.isArray(parsed.skills) ? parsed.skills : [parsed.skills]) {
          if (typeof path === 'string') keep.add(`${path.replace(/^\.\//, '').replace(/\/+$/, '')}/`);
        }
      }
    } catch {
      // No manifest: a package of skills only.
    }
    return [...keep];
  }

  // --- views ---

  private async byName(name: string): Promise<PluginRow | undefined> {
    const [row] = await this.deps.db.select().from(plugins).where(eq(plugins.name, name));
    return row;
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expiresAt < now) this.previews.delete(id);
  }

  private presentPreview(preview: Preview, installed: PluginRow | undefined): PluginPreview {
    const { plan } = preview;
    return {
      id: preview.id,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      source: preview.source as PluginPreview['source'],
      sha: preview.sha,
      format: plan.format,
      name: plan.name,
      title: plan.title,
      version: plan.version,
      description: plan.description,
      license: plan.license,
      homepage: plan.homepage,
      installed: Boolean(installed),
      skills: plan.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        files: skill.files,
        bytes: skill.bytes,
      })),
      mcpServers: plan.servers.map((server) => ({
        key: server.key,
        slug: server.slug,
        transport: server.transport,
        command: server.transport === 'stdio' ? server.command : null,
        package: server.package ? `${server.package}@${server.version}` : null,
        url: server.url,
        env: Object.keys(server.env),
      })),
      inputs: plan.inputs,
      skipped: plan.skipped,
      warnings: plan.warnings,
      files: preview.files.size,
      bytes: preview.bytes,
    };
  }

  private present(row: PluginRow): Plugin {
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      version: row.version,
      description: row.description,
      format: row.format,
      source: row.source as Plugin['source'],
      sha: row.sha,
      license: row.license,
      status: row.status,
      statusDetail: row.statusDetail,
      network: row.network,
      skills: this.deps.skills
        .list()
        .filter((skill) => skill.pluginId === row.id)
        .map((skill) => `${row.name}/${skill.name}`),
      mcpServers: this.deps.mcp.ofPlugin(row.id).map((server) => server.slug),
      warnings: row.warnings,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
