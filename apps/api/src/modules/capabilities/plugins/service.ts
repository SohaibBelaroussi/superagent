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
import {
  type McpServerRow,
  mcpServers,
  type PluginRow,
  pluginFiles,
  plugins,
  skills,
} from '../../../db/schema';
import { ApiError } from '../../../http/problem';
import { Mutex } from '../../../util/mutex';
import type { RunnerClient } from '../../workspace/runner-client';
import { mcpToolKeys } from '../mcp/naming';
import type { McpService } from '../mcp/service';
import type { SecretService } from '../secrets';
import type { SkillStore } from '../skills';
import { ARCHIVE_LIMITS, type PluginFetcher, type PluginFile } from './fetch';
import {
  CONTAINER_ROOT,
  type PlannedServer,
  type PluginPlan,
  placeholders,
  planPlugin,
  render,
} from './formats';
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

interface Preview {
  id: string;
  expiresAt: number;
  source: PluginSource;
  sha: string | null;
  plan: PluginPlan;
  files: Map<string, PluginFile>;
  bytes: number;
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
 * Plugins (decision D38): previewed from a pinned source, then installed into owned rows: their
 * files, skills, MCP servers and the secrets their inputs became. stdio servers are set up in the
 * background (files and packages into the runner's volume, then tool discovery). Uninstalling detaches
 * them from agents and departments and removes all of it.
 */
export class PluginService {
  private readonly previews = new Map<string, Preview>();
  private readonly lock = new Mutex();
  private readonly setups = new Set<Promise<void>>();

  constructor(private readonly deps: PluginDeps) {}

  async preview(source: PluginSource): Promise<PluginPreview> {
    this.expire();
    const { files, sha } = await this.fetch(source);
    const plan = planPlugin(files, {
      takenSlugs: new Set(this.deps.mcp.list().map((server) => server.slug)),
      fallbackName: fallbackName(source),
    });
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
    const values = input.inputs ?? {};
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
      const secretsToWrite: Array<{ name: string; value: string }> = [];
      const rows: McpServerRow[] = [];
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
        for (const server of servers) {
          const extra = input.servers?.[server.key];
          const env = this.values(plan, server, server.env, values, secretsToWrite, 'ENV');
          const headers = this.values(plan, server, server.headers, values, secretsToWrite, 'HEADER');
          const [row] = await tx
            .insert(mcpServers)
            .values({
              id: randomUUID(),
              slug: server.slug,
              name: `${plan.title}: ${server.key}`,
              description: `MCP server ${server.key} of the ${plan.name} plugin`,
              pluginId: id,
              key: server.key,
              transport: server.transport,
              url: server.url,
              headers: { ...headers, ...(extra?.headers ?? {}) },
              runtime: server.runtime,
              package: server.package ? `${server.package}@${server.version}` : null,
              command: server.transport === 'stdio' ? server.command : null,
              cwd: server.cwd,
              env: { ...env, ...(extra?.env ?? {}) },
              status: 'pending',
            })
            .returning();
          rows.push(row as McpServerRow);
        }
      });
      for (const secret of secretsToWrite) {
        await this.deps.secrets.put(
          secret.name,
          { value: secret.value, description: `For the ${plan.name} plugin` },
          { pluginId: id },
        );
      }
      // Its servers' secrets (given at install) must exist before they are used.
      const named = rows.flatMap((row) => [...Object.values(row.env), ...Object.values(row.headers)]);
      const absent = await this.deps.secrets.missing(named.flatMap((v) => ('secret' in v ? [v.secret] : [])));
      if (absent.length > 0) {
        await this.deps.db.delete(plugins).where(eq(plugins.id, id));
        throw new ApiError(
          400,
          'secret_missing',
          `No secret named ${absent.join(', ')} (PUT /v1/secrets/{name})`,
        );
      }
      await this.deps.skills.load();
      this.deps.mcp.adopt(rows, plan.name);
      this.previews.delete(preview.id);
      this.deps.logger.info('Plugin installed', {
        plugin: plan.name,
        skills: plan.skills.length,
        servers: rows.length,
      });
      if (rows.length > 0) this.track(this.setUp(id, plan.name, rows, preview.files, plan));
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
   * Removes a plugin and everything it brought: its skills and servers leave the agents (a new version
   * of each) and departments that had them, its containers and volumes go, then its rows and secrets.
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
      await this.deps.mcp.forgetPlugin(id);
      if (servers.some((server) => server.transport === 'stdio')) {
        await this.deps.runner?.removeMcp(id, true).catch((error: unknown) => {
          this.deps.logger.warn("Could not remove a plugin's MCP container", { plugin: row.name, error });
        });
      }
      await this.deps.db.delete(plugins).where(eq(plugins.id, id));
      await this.deps.skills.load();
      this.deps.logger.info('Plugin uninstalled', { plugin: row.name });
    });
  }

  /** Waits for background setups (shutdown and tests). */
  async settled(): Promise<void> {
    while (this.setups.size > 0) await Promise.allSettled([...this.setups]);
  }

  // --- install helpers ---

  /**
   * A server's environment or headers: values with placeholders are filled from the install inputs,
   * and a value that holds a sensitive input becomes a secret owned by the plugin.
   */
  private values(
    plan: PluginPlan,
    server: PlannedServer,
    templates: Record<string, string>,
    inputs: Record<string, string>,
    secrets: Array<{ name: string; value: string }>,
    kind: string,
  ): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {};
    const sensitive = new Set(plan.inputs.filter((i) => i.sensitive).map((i) => i.name));
    for (const [name, template] of Object.entries(templates)) {
      // Agent Plugins packages take no values: their text is used as is.
      if (plan.format === 'agent-plugins') {
        out[name] = { value: template };
        continue;
      }
      const value = render(template, inputs);
      if (placeholders(template).some((p) => sensitive.has(p))) {
        const secret = `${plan.name}_${server.key}_${kind}_${name}`
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_')
          .slice(0, 64);
        secrets.push({ name: secret, value });
        out[name] = { secret };
      } else out[name] = { value };
    }
    return out;
  }

  /** Puts a plugin's stdio servers in place (files, packages), then asks every server for its tools. */
  private async setUp(
    id: string,
    name: string,
    rows: McpServerRow[],
    files: Map<string, PluginFile>,
    plan: PluginPlan,
  ): Promise<void> {
    const problems: string[] = [];
    let ready = rows;
    const stdio = rows.filter((row) => row.transport === 'stdio');
    if (stdio.length > 0) {
      const runner = this.deps.runner;
      if (!runner) {
        problems.push('stdio servers need the runner (RUNNER_URL and RUNNER_TOKEN)');
        ready = rows.filter((row) => row.transport === 'http');
      } else {
        try {
          // The plugin's files, without its skills (agents read those from the database).
          const skillDirs = plan.skills.map((skill) => `${skill.dir}/`);
          const kept = [...files.entries()]
            .filter(([path]) => !skillDirs.some((dir) => path.startsWith(dir)))
            .map(([path, file]) => ({ path, mode: file.mode, data: file.data }));
          await runner.mcpFiles(id, writeTar(kept));
          const packaged = stdio.filter((row) => row.runtime === 'npm' || row.runtime === 'uv');
          if (packaged.length > 0) {
            const planned = new Map(plan.servers.map((server) => [server.key, server]));
            const result = await runner.mcpInstall(id, {
              servers: packaged.map((row) => {
                const server = planned.get(row.key ?? '') as PlannedServer;
                return {
                  key: row.key ?? '',
                  runtime: row.runtime as 'npm' | 'uv',
                  package: server.package as string,
                  version: server.version as string,
                  ...(server.bin ? { bin: server.bin } : {}),
                };
              }),
            });
            for (const installed of result.servers) {
              const row = packaged.find((r) => r.key === installed.key) as McpServerRow;
              const server = planned.get(installed.key) as PlannedServer;
              if (!installed.ok || !installed.executable) {
                problems.push(`${row.slug}: install failed (${installed.log.slice(-300)})`);
                ready = ready.filter((r) => r.id !== row.id);
                await this.deps.mcp.fail(row.id, `Its package did not install: ${installed.log.slice(-500)}`);
                continue;
              }
              const command =
                row.runtime === 'npm'
                  ? ['node', installed.executable, ...server.command]
                  : [installed.executable, ...server.command];
              const [next] = await this.deps.db
                .update(mcpServers)
                .set({
                  command,
                  package: `${server.package}@${installed.version ?? server.version}`,
                  updatedAt: new Date(),
                })
                .where(eq(mcpServers.id, row.id))
                .returning();
              this.deps.mcp.adopt([next as McpServerRow], name);
            }
          }
        } catch (error) {
          problems.push(`setting up its stdio servers failed: ${(error as Error).message}`);
          ready = rows.filter((row) => row.transport === 'http');
          for (const row of stdio) await this.deps.mcp.fail(row.id, (error as Error).message);
        }
      }
    }
    for (const row of ready) {
      try {
        const current = this.deps.mcp.ofPlugin(id).find((r) => r.id === row.id) ?? row;
        if (current.transport === 'stdio') await this.deps.mcp.launch(current);
        const server = await this.deps.mcp.refresh(row.id);
        if (server.status !== 'ready') problems.push(`${server.slug}: ${server.statusDetail ?? 'no tools'}`);
      } catch (error) {
        problems.push(`${row.slug}: ${(error as Error).message}`);
        await this.deps.mcp.fail(row.id, (error as Error).message);
      }
    }
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

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => this.deps.logger.error('Plugin setup failed', { error }));
    this.setups.add(tracked);
    void tracked.finally(() => this.setups.delete(tracked));
  }

  // --- fetching ---

  private async fetch(source: PluginSource): Promise<{ files: Map<string, PluginFile>; sha: string | null }> {
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
      return { files: unpacked.files, sha: null };
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
    return { files: unpacked.files, sha };
  }

  /** What to keep of a repository's archive: manifests, skills, and the folders bundled servers run from. */
  private keepFor(probed: Map<string, PluginFile>): string[] {
    const keep = new Set([
      ...MANIFESTS,
      '.codex-plugin/',
      '.claude-plugin/',
      'skills/',
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
    ]);
    keep.add('package.json');
    keep.add('package-lock.json');
    try {
      const plan = planPlugin(probed, { fallbackName: 'probe' });
      for (const server of plan.servers) {
        for (const part of server.command) {
          if (!part.startsWith(`${CONTAINER_ROOT}/`)) continue;
          const rel = part.slice(CONTAINER_ROOT.length + 1);
          keep.add(rel.includes('/') ? `${rel.split('/')[0]}/` : rel);
        }
      }
      for (const manifest of [
        probed.get('.codex-plugin/plugin.json'),
        probed.get('.claude-plugin/plugin.json'),
      ]) {
        if (!manifest) continue;
        const skillsField = (JSON.parse(manifest.data.toString('utf8')) as { skills?: unknown }).skills;
        for (const path of Array.isArray(skillsField) ? skillsField : [skillsField]) {
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
