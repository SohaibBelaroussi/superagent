import type { Server } from 'node:http';
import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import { SpanType } from '@mastra/core/observability';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import type { McpGrant, ToolGrant } from '@superagent/shared';
import type { Hono } from 'hono';
import type pg from 'pg';
import { createApp } from './app';
import { ApiTokenAuth } from './auth/provider';
import { TokenService } from './auth/tokens';
import type { Config } from './config';
import { SecretBox } from './crypto/secret-box';
import { createDb, createPool, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import { ApiError } from './http/problem';
import type { AppEnv } from './http/types';
import { createLogger } from './logger';
import { createMastra } from './mastra';
import { createChiefAgent } from './mastra/agents/chief';
import { createScratchAgent } from './mastra/agents/scratch';
import { DecisionService } from './modules/attention/decisions';
import { AttentionService } from './modules/attention/service';
import { IdentityService } from './modules/browser/identities';
import { BrowserService } from './modules/browser/service';
import { McpService } from './modules/capabilities/mcp/service';
import { PluginFetcher } from './modules/capabilities/plugins/fetch';
import { PluginService } from './modules/capabilities/plugins/service';
import { SecretService } from './modules/capabilities/secrets';
import { SkillStore } from './modules/capabilities/skills';
import { DecisionLog } from './modules/dispatch/decisions';
import { DispatchService } from './modules/dispatch/service';
import { type BlobStore, S3BlobStore } from './modules/knowledge/blobs';
import { KnowledgeService } from './modules/knowledge/service';
import { EventBus } from './modules/ledger/events';
import { TaskService } from './modules/ledger/service';
import { createChiefTools, createLeadTools } from './modules/ledger/tools';
import { createMemoryProfiles, OwnerProfileProcessor } from './modules/memory/profiles';
import { MemoryService } from './modules/memory/service';
import { createMemoryTools } from './modules/memory/tools';
import { OrgDirectory } from './modules/org/directory';
import { AgentRuntime } from './modules/org/runtime';
import { OrgService } from './modules/org/service';
import { ProviderGateway } from './modules/providers/gateway';
import { GATEWAY_ID } from './modules/providers/model-ref';
import { ProviderRegistry } from './modules/providers/registry';
import { ProviderService } from './modules/providers/service';
import { ScheduleService } from './modules/schedules/service';
import { createScheduleTools } from './modules/schedules/tools';
import { SettingsService } from './modules/settings/service';
import { ToolCatalog } from './modules/tools/catalog';
import type { ResolveHost } from './modules/tools/web';
import { UsageExporter } from './modules/usage/exporter';
import { TracePruner } from './modules/usage/retention';
import { UsageService } from './modules/usage/service';
import { RunnerClient } from './modules/workspace/runner-client';
import { WorkspaceService } from './modules/workspace/service';

export interface System {
  config: Config;
  logger: IMastraLogger;
  pool: pg.Pool;
  db: Db;
  tokens: TokenService;
  providers: ProviderService;
  settings: SettingsService;
  org: OrgService;
  tasks: TaskService;
  dispatch: DispatchService;
  knowledge: KnowledgeService;
  memory: MemoryService;
  schedules: ScheduleService;
  attention: AttentionService;
  workspaces: WorkspaceService;
  browsers: BrowserService;
  identities: IdentityService;
  secrets: SecretService;
  mcp: McpService;
  skills: SkillStore;
  plugins: PluginService;
  usage: UsageService;
  mastra: Mastra;
  app: Hono<AppEnv>;
  /** Serves live views (WebSockets) on the server that serves `app`. */
  injectWebSocket(server: Server): void;
  /** Drains Mastra and closes the database pool. Does not touch the HTTP server. */
  close(drainTimeoutMs?: number): Promise<void>;
}

export interface BootstrapOptions {
  logger?: IMastraLogger;
  /** Extra agents to register (tests use scripted mock agents). */
  agents?: Record<string, Agent>;
  /** Replaces S3 object storage (tests use an in-memory store). */
  blobs?: BlobStore;
  /** How web tools and browsers resolve names to check they are public (tests use fixed answers). */
  resolveHost?: ResolveHost;
}

/** Builds the whole server without listening: migrations, providers, Mastra storage, auth, routes. */
export async function bootstrap(config: Config, options: BootstrapOptions = {}): Promise<System> {
  const logger = options.logger ?? createLogger(config);
  const pool = createPool(config);
  // pg emits 'error' when an idle client dies (e.g. Postgres restarts). Without a listener Node
  // treats it as an uncaught exception and the whole API exits; the pool reconnects on its own.
  pool.on('error', (error) => logger.error('Postgres connection error (idle client)', { error }));
  try {
    const db = createDb(pool);
    await runMigrations(db);

    const tokens = new TokenService(db, config.SUPERAGENT_ADMIN_TOKEN, { logger });
    const box = new SecretBox(config.SUPERAGENT_ENCRYPTION_KEY);
    const registry = new ProviderRegistry(db, box, logger);
    await registry.reload();
    const providers = new ProviderService(db, box, registry, logger);
    const settings = new SettingsService(db, SettingsService.defaultsFor(config.DEFAULT_TIMEZONE));
    await settings.load();
    const directory = new OrgDirectory(db);
    await directory.reload();
    const blobs =
      options.blobs ??
      (config.S3_ACCESS_KEY && config.S3_SECRET_KEY
        ? new S3BlobStore({
            endpoint: config.S3_ENDPOINT,
            bucket: config.S3_BUCKET,
            region: config.S3_REGION,
            accessKey: config.S3_ACCESS_KEY,
            secretKey: config.S3_SECRET_KEY,
          })
        : undefined);
    if (!blobs) logger.warn('Document storage is off: set S3_ACCESS_KEY and S3_SECRET_KEY to enable uploads');
    const knowledge = new KnowledgeService(db, directory, blobs, logger);
    const bus = new EventBus();
    const tasks = new TaskService(db, directory, bus);
    // The runner (decision D10) runs tasks' sandboxes and browsers.
    const runner =
      config.RUNNER_URL && config.RUNNER_TOKEN
        ? new RunnerClient(config.RUNNER_URL, config.RUNNER_TOKEN)
        : undefined;
    // Agents' browsers and their signed-in identities (decision D34).
    const identities = new IdentityService(db, tasks, runner, (name) =>
      directory
        .agents()
        .filter((agent) =>
          agent.current.tools.some((grant) => grant.key === 'browser' && grant.identity === name),
        )
        .map((agent) => agent.key),
    );
    const browsers = new BrowserService({
      client: runner,
      identities,
      tasks,
      bus,
      logger,
      idleCloseMs: config.BROWSER_IDLE_CLOSE_MS,
      identityWaitMs: config.BROWSER_IDENTITY_WAIT_MS,
      resolveHost: options.resolveHost,
    });
    // Capabilities (decisions D35-D38): the secrets vault, MCP servers, skills, and the plugins that bring them.
    const secrets = new SecretService(db, box);
    const skills = new SkillStore(db);
    await skills.load();
    const mcp = new McpService({
      db,
      secrets,
      logger,
      runner:
        runner && config.RUNNER_URL && config.RUNNER_TOKEN
          ? { client: runner, url: config.RUNNER_URL.replace(/\/+$/, ''), token: config.RUNNER_TOKEN }
          : undefined,
      grantedTo: (slug) => directory.grantingMcp(slug),
      resolveHost: options.resolveHost,
    });
    await mcp.load();
    const catalog = new ToolCatalog({
      settings,
      web: {
        searxngUrl: config.SEARXNG_URL,
        crawl4aiUrl: config.CRAWL4AI_URL,
        crawl4aiToken: config.CRAWL4AI_API_TOKEN,
        resolveHost: options.resolveHost,
      },
      knowledge,
      directory,
      browsers,
    });

    const storage = new PostgresStore({
      id: 'superagent-mastra',
      pool,
      schemaName: 'mastra',
      ...(config.TRACE_RETENTION_DAYS > 0
        ? { retention: { observability: { spans: { maxAge: `${config.TRACE_RETENTION_DAYS}d` } } } }
        : {}),
    });
    // Every run is traced (decision D39); each model call becomes a usage row, priced (decision D40).
    const usage = new UsageService({
      db,
      priceOf: (provider, model) => registry.priceOf(provider, model),
      timezone: () => settings.get().timezone,
      logger,
    });
    const mastra = createMastra({
      storage,
      logger,
      auth: new ApiTokenAuth(tokens),
      studioToken: config.STUDIO_TOKEN,
      gateways: { [GATEWAY_ID]: new ProviderGateway(registry) },
      agents: { scratch: createScratchAgent(settings), ...options.agents },
      observability: new Observability({
        configs: {
          default: {
            serviceName: 'superagent',
            exporters: [new MastraStorageExporter(), new UsageExporter(usage)],
            excludeSpanTypes: [SpanType.MODEL_CHUNK],
          },
        },
      }),
    });
    await storage.init();
    const pruner = new TracePruner(storage, logger);
    if (config.TRACE_RETENTION_DAYS > 0) pruner.start();

    // A thread per task (resource dept:<slug>) and the owner's thread with the chief (resource owner).
    // Long threads are compressed with the fast model, or the default one while the fast one can't be
    // used (unset, its provider disabled, its key unreadable): a failing observer stops every turn.
    const observerModel = () => {
      const fast = settings.get().models.fast;
      return settings.modelRouterId(fast && providers.isUsable(fast, 'chat') ? 'fast' : 'default');
    };
    const memory = createMemoryProfiles(storage, observerModel, {
      observeTokens: config.MEMORY_OBSERVE_TOKENS,
      reflectTokens: config.MEMORY_REFLECT_TOKENS,
      observeAhead: config.MEMORY_OBSERVE_AHEAD,
    });
    const memoryService = new MemoryService(db, directory, logger);
    const memoryTools = createMemoryTools(memoryService, directory);
    // Sandboxes for agents granted files or shell (decision D33), when a runner is configured.
    const workspaces = new WorkspaceService({
      client: runner,
      profile: config.SANDBOX_PROFILE,
      tasks,
      logger,
    });
    if (!workspaces.enabled) logger.warn('Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN to enable them');
    const decisionLog = new DecisionLog(db);
    const dispatch = new DispatchService({
      mastra,
      decisions: decisionLog,
      tasks,
      directory,
      memory,
      logger,
    });
    const ledgerTools = { tasks, dispatch, directory };
    const schedules = new ScheduleService({
      db,
      directory,
      tasks,
      dispatch,
      settings,
      logger,
      tickMs: config.SCHEDULER_TICK_MS,
    });
    const scheduleTools = createScheduleTools(schedules, directory);
    mastra.addAgent(
      createChiefAgent({
        directory,
        settings,
        catalog,
        memory: memory.chief,
        chiefTools: { ...createChiefTools(ledgerTools), ...memoryTools.chief, ...scheduleTools.chief },
        ownerProfile: new OwnerProfileProcessor(memoryService, true),
      }),
      'chief',
    );

    // Agent definitions from our tables become live Mastra agents (decision D14).
    const runtime = new AgentRuntime(
      {
        mastra,
        directory,
        settings,
        catalog,
        memory,
        ownerProfile: new OwnerProfileProcessor(memoryService, false),
        memoryService,
        leadTools: { ...createLeadTools(ledgerTools), ...memoryTools.lead, ...scheduleTools.lead },
        workspaces,
        mcp,
        skills,
      },
      logger,
    );
    runtime.loadAll();
    // A server's tools changed (listed again, enabled, removed): the agents granting it are rebuilt.
    mcp.onToolsChanged((slugs) => runtime.recompileGranting(slugs));
    const org = new OrgService(db, directory, runtime, providers, catalog, logger, settings.lock, {
      archiveBlocker: (agent) => dispatch.archiveBlocker(agent),
      departmentArchived: (departmentId) => schedules.pauseDepartment(departmentId),
      checkGrants: (grants) => checkCapabilities(grants, { identities, skills, mcp }),
      departmentChanged: (departmentId) => runtime.recompileDepartment(departmentId),
    });
    const plugins = new PluginService({
      db,
      fetcher: new PluginFetcher({
        resolveHost: options.resolveHost,
        githubToken: async () => {
          if ((await secrets.missing(['GITHUB_TOKEN'])).length > 0) return undefined;
          return (await secrets.resolve({ token: { secret: 'GITHUB_TOKEN' } })).token;
        },
      }),
      secrets,
      skills,
      mcp,
      runner,
      detach: (plugin, slugs) => org.detachCapabilities(plugin, slugs),
      pendingApprovals: async () => (await dispatch.listApprovals()).map((approval) => approval.tool),
      logger,
    });
    // Setups a restart cut short are marked failed; what the runner keeps for gone plugins is removed.
    await plugins.recover();
    const reconciled = plugins.reconcile().catch((error: unknown) =>
      logger.warn("Could not check the runner for uninstalled plugins' leftovers", {
        error: String(error),
      }),
    );

    await dispatch.ensureChiefThread();
    const interrupted = await dispatch.recoverInterrupted();
    if (interrupted > 0) logger.warn('Flagged tasks interrupted by a restart', { count: interrupted });
    // The first tick also catches up on fires missed while the server was down.
    schedules.start();
    await browsers.start();
    const attention = new AttentionService({
      dispatch,
      directory,
      tasks,
      schedules,
      settings,
      providers,
      storageEnabled: knowledge.enabled,
      workspaces,
      browsers,
      mcp,
    });
    const decisions = new DecisionService(decisionLog, attention, dispatch, logger);

    const http = await createApp({
      config,
      logger,
      mastra,
      db,
      tokens,
      providers,
      settings,
      org,
      catalog,
      tasks,
      dispatch,
      bus,
      knowledge,
      memory: memoryService,
      schedules,
      attention,
      decisions,
      workspaces,
      browsers,
      identities,
      secrets,
      mcp,
      skills,
      plugins,
      usage,
    });
    return {
      config,
      logger,
      pool,
      db,
      tokens,
      providers,
      settings,
      org,
      tasks,
      dispatch,
      knowledge,
      memory: memoryService,
      schedules,
      attention,
      workspaces,
      browsers,
      identities,
      secrets,
      mcp,
      skills,
      plugins,
      usage,
      mastra,
      app: http.app,
      injectWebSocket: http.injectWebSocket,
      async close(drainTimeoutMs = 5_000) {
        http.closeWebSockets();
        await schedules.stop();
        await dispatch.close(drainTimeoutMs);
        // Saves identities' cookies and frees their locks.
        await browsers.stop();
        await plugins.settled();
        await reconciled;
        await mcp.close();
        await pruner.close();
        // Mastra closes its storage before its tracing: spans and usage rows are written first.
        await mastra.observability.flush().catch(() => {});
        await usage.flush();
        await mastra.shutdown({ drainTimeout: drainTimeoutMs });
        // Observational memory may still be writing in the background.
        await Promise.all([memory.chief.settled(), memory.lead.settled(), memory.specialist.settled()]);
        blobs?.close?.();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

/**
 * What grants refer to must exist: a browser grant's identity, skills, MCP servers and the tools a
 * grant lists (once the server's tools are known).
 */
async function checkCapabilities(
  grants: { tools?: ToolGrant[]; skills?: string[]; mcp?: McpGrant[] },
  deps: { identities: IdentityService; skills: SkillStore; mcp: McpService },
): Promise<void> {
  await checkIdentities(grants.tools ?? [], deps.identities);
  if (grants.skills) deps.skills.assertRefs(grants.skills);
  const seen = new Set<string>();
  for (const grant of grants.mcp ?? []) {
    if (seen.has(grant.server)) {
      throw new ApiError(400, 'duplicate_mcp_grant', `MCP server "${grant.server}" is listed twice`);
    }
    seen.add(grant.server);
    const server = deps.mcp.bySlug(grant.server);
    if (!server) {
      throw new ApiError(400, 'unknown_mcp_server', `No MCP server "${grant.server}" (GET /v1/mcp-servers)`);
    }
    const known = new Set(server.tools.map((tool) => tool.name));
    const unknown = server.status === 'ready' ? (grant.tools ?? []).filter((tool) => !known.has(tool)) : [];
    if (unknown.length > 0) {
      throw new ApiError(400, 'unknown_mcp_tool', `"${grant.server}" has no tool ${unknown.join(', ')}`);
    }
  }
}

/** A browser grant's identity must exist (agents name identities, the owner creates them). */
async function checkIdentities(grants: ToolGrant[], identities: IdentityService): Promise<void> {
  for (const grant of grants) {
    if (grant.identity && !(await identities.byName(grant.identity))) {
      throw new ApiError(
        400,
        'unknown_identity',
        `No browser identity named "${grant.identity}" (GET /v1/browser-identities)`,
      );
    }
  }
}
