import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
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
  mastra: Mastra;
  app: Hono<AppEnv>;
  /** Drains Mastra and closes the database pool. Does not touch the HTTP server. */
  close(drainTimeoutMs?: number): Promise<void>;
}

export interface BootstrapOptions {
  logger?: IMastraLogger;
  /** Extra agents to register (tests use scripted mock agents). */
  agents?: Record<string, Agent>;
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
    const catalog = new ToolCatalog({
      settings,
      web: {
        searxngUrl: config.SEARXNG_URL,
        crawl4aiUrl: config.CRAWL4AI_URL,
        crawl4aiToken: config.CRAWL4AI_API_TOKEN,
      },
    });

    const storage = new PostgresStore({ id: 'superagent-mastra', pool, schemaName: 'mastra' });
    const mastra = createMastra({
      storage,
      logger,
      auth: new ApiTokenAuth(tokens),
      studioToken: config.STUDIO_TOKEN,
      gateways: { [GATEWAY_ID]: new ProviderGateway(registry) },
      agents: {
        chief: createChiefAgent({ directory, settings, catalog }),
        scratch: createScratchAgent(settings),
        ...options.agents,
      },
    });
    await storage.init();

    // Agent definitions from our tables become live Mastra agents (decision D14).
    const runtime = new AgentRuntime({ mastra, directory, settings, catalog }, logger);
    runtime.loadAll();
    const org = new OrgService(db, directory, runtime, providers, catalog, logger);

    const app = await createApp({ config, logger, mastra, db, tokens, providers, settings, org, catalog });
    return {
      config,
      logger,
      pool,
      db,
      tokens,
      providers,
      settings,
      org,
      mastra,
      app,
      async close(drainTimeoutMs = 5_000) {
        await mastra.shutdown({ drainTimeout: drainTimeoutMs });
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
