import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import type { Hono } from 'hono';
import type pg from 'pg';
import { createApp } from './app';
import { ApiTokenAuth } from './auth/provider';
import { TokenService } from './auth/tokens';
import type { Config } from './config';
import { SecretBox } from './crypto/secret-box';
import { createDb, createPool, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import type { AppEnv } from './http/types';
import { createLogger } from './logger';
import { createMastra } from './mastra';
import { createChiefAgent } from './mastra/agents/chief';
import { createScratchAgent } from './mastra/agents/scratch';
import { DispatchService } from './modules/dispatch/service';
import { type BlobStore, S3BlobStore } from './modules/knowledge/blobs';
import { KnowledgeService } from './modules/knowledge/service';
import { EventBus } from './modules/ledger/events';
import { TaskService } from './modules/ledger/service';
import { createChiefTools, createLeadTools } from './modules/ledger/tools';
import { OrgDirectory } from './modules/org/directory';
import { AgentRuntime } from './modules/org/runtime';
import { OrgService } from './modules/org/service';
import { ProviderGateway } from './modules/providers/gateway';
import { GATEWAY_ID } from './modules/providers/model-ref';
import { ProviderRegistry } from './modules/providers/registry';
import { ProviderService } from './modules/providers/service';
import { SettingsService } from './modules/settings/service';
import { ToolCatalog } from './modules/tools/catalog';

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
  mastra: Mastra;
  app: Hono<AppEnv>;
  /** Drains Mastra and closes the database pool. Does not touch the HTTP server. */
  close(drainTimeoutMs?: number): Promise<void>;
}

export interface BootstrapOptions {
  logger?: IMastraLogger;
  /** Extra agents to register (tests use scripted mock agents). */
  agents?: Record<string, Agent>;
  /** Replaces S3 object storage (tests use an in-memory store). */
  blobs?: BlobStore;
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
    const catalog = new ToolCatalog({
      settings,
      web: {
        searxngUrl: config.SEARXNG_URL,
        crawl4aiUrl: config.CRAWL4AI_URL,
        crawl4aiToken: config.CRAWL4AI_API_TOKEN,
      },
      knowledge,
      directory,
    });

    const storage = new PostgresStore({ id: 'superagent-mastra', pool, schemaName: 'mastra' });
    const mastra = createMastra({
      storage,
      logger,
      auth: new ApiTokenAuth(tokens),
      studioToken: config.STUDIO_TOKEN,
      gateways: { [GATEWAY_ID]: new ProviderGateway(registry) },
      agents: { scratch: createScratchAgent(settings), ...options.agents },
    });
    await storage.init();

    // One message history for every agent: a thread per task, the owner's thread with the chief.
    const memory = new Memory({ storage, options: { lastMessages: 40 } });
    const bus = new EventBus();
    const tasks = new TaskService(db, directory, bus);
    const dispatch = new DispatchService({ mastra, tasks, directory, memory, logger });
    const ledgerTools = { tasks, dispatch, directory };
    mastra.addAgent(
      createChiefAgent({ directory, settings, catalog, memory, chiefTools: createChiefTools(ledgerTools) }),
      'chief',
    );

    // Agent definitions from our tables become live Mastra agents (decision D14).
    const runtime = new AgentRuntime(
      { mastra, directory, settings, catalog, memory, leadTools: createLeadTools(ledgerTools) },
      logger,
    );
    runtime.loadAll();
    const org = new OrgService(db, directory, runtime, providers, catalog, logger, settings.lock);

    await dispatch.ensureChiefThread();
    const interrupted = await dispatch.recoverInterrupted();
    if (interrupted > 0) logger.warn('Flagged tasks interrupted by a restart', { count: interrupted });

    const app = await createApp({
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
      mastra,
      app,
      async close(drainTimeoutMs = 5_000) {
        await dispatch.close(drainTimeoutMs);
        await mastra.shutdown({ drainTimeout: drainTimeoutMs });
        blobs?.close?.();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
