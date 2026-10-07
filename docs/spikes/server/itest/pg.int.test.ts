import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { PostgresStore } from '@mastra/pg';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
beforeAll(async () => {
  const t0 = Date.now();
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  console.log('container start ms', Date.now() - t0);
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });

describe('pg integration', () => {
  it('initialises Mastra storage on a throwaway pgvector container', async () => {
    const store = new PostgresStore({ id: 'it', pool, schemaName: 'mastra' });
    const t0 = Date.now();
    await store.init();
    console.log('PostgresStore.init ms', Date.now() - t0);
    const { rows } = await pool.query(`select count(*)::int n from information_schema.tables where table_schema='mastra'`);
    expect(rows[0].n).toBeGreaterThan(30);
  });
});
