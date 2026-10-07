import { randomBytes } from 'node:crypto';
import type { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import pg from 'pg';
import { inject } from 'vitest';
import { bootstrap, type System } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { createLogger } from '../../src/logger';
import { type BlobStore, MemoryBlobStore } from '../../src/modules/knowledge/blobs';

export const TEST_ADMIN_TOKEN = `sa_test_${'t'.repeat(40)}`;
/** Fixed test-only key (32 bytes, base64). */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export function authHeader(token = TEST_ADMIN_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function jsonHeaders(token = TEST_ADMIN_TOKEN): Record<string, string> {
  return { ...authHeader(token), 'content-type': 'application/json' };
}

/** A fresh, empty database on the shared test server. */
export async function createTestDatabase(): Promise<string> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Boots the full server (migrations, Mastra storage, routes) on its own database. Set TEST_LOG=1 to see logs. */
export async function startTestSystem(
  options: {
    agents?: Record<string, Agent>;
    env?: Record<string, string>;
    blobs?: BlobStore;
    /** Boot on an existing database (a restart) instead of a fresh one. */
    databaseUrl?: string;
  } = {},
): Promise<System> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: options.databaseUrl ?? (await createTestDatabase()),
    SUPERAGENT_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    SUPERAGENT_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DATABASE_POOL_MAX: '5',
    ...options.env,
  });
  const logger = process.env.TEST_LOG
    ? createLogger({ LOG_LEVEL: 'debug', NODE_ENV: 'development' })
    : noopLogger;
  return bootstrap(config, { logger, agents: options.agents, blobs: options.blobs ?? new MemoryBlobStore() });
}
