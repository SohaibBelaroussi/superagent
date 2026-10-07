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
import { createDb, createPool, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import type { AppEnv } from './http/types';
import { createLogger } from './logger';
import { createMastra } from './mastra';

export interface System {
  config: Config;
  logger: IMastraLogger;
  pool: pg.Pool;
  db: Db;
  tokens: TokenService;
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

/** Builds the whole server without listening: migrations, Mastra storage, auth, routes. */
export async function bootstrap(config: Config, options: BootstrapOptions = {}): Promise<System> {
  const logger = options.logger ?? createLogger(config);
  const pool = createPool(config);
  try {
    const db = createDb(pool);
    await runMigrations(db);

    const tokens = new TokenService(db, config.SUPERAGENT_ADMIN_TOKEN, { logger });
    const storage = new PostgresStore({ id: 'superagent-mastra', pool, schemaName: 'mastra' });
    const mastra = createMastra({
      storage,
      logger,
      auth: new ApiTokenAuth(tokens),
      studioToken: config.STUDIO_TOKEN,
      agents: options.agents,
    });
    await storage.init();

    const app = await createApp({ config, logger, mastra, db, tokens });
    return {
      config,
      logger,
      pool,
      db,
      tokens,
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
