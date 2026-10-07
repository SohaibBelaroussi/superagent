import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import { tasks } from './db/schema.ts';
import { scripted } from './mock.ts';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:spike@localhost:55432/postgres';
const log = (label: string, v: unknown) => console.log(label.padEnd(50), typeof v === 'string' ? v : JSON.stringify(v));

const pool = new pg.Pool({ connectionString: url, max: 10 });
const db = drizzle(pool, { schema: { tasks } });

// 1. our migrations first (app schema + pgvector extension in public)
const migrationsSchema = process.env.MIG_SCHEMA ?? 'app';
try {
  await migrate(db, { migrationsFolder: './db/migrations', migrationsSchema, migrationsTable: '__drizzle_migrations' });
  log(`1 drizzle migrate (migrationsSchema=${migrationsSchema})`, 'ok');
} catch (e: any) {
  log(`1 drizzle migrate (migrationsSchema=${migrationsSchema})`, `ERROR ${e.message?.slice(0, 160)} ${e.cause?.message ?? ''}`);
  await pool.end();
  process.exit(1);
}

// 2. Mastra storage sharing the same pool, in its own schema
const storage = new PostgresStore({ id: 'mastra-pg', pool, schemaName: 'mastra' });
const lead = new Agent({ id: 'lead', name: 'Lead', instructions: 'x', memory: new Memory(), model: scripted([{ text: 'ok' }]) });
const mastra = new Mastra({ agents: { lead }, storage, logger: false as any });
const t0 = Date.now();
await mastra.getStorage()!.init();
log('2 PostgresStore.init() ms', Date.now() - t0);
log('   store.pool === our pool', (storage as any).pool === pool);
log('   store.db.one(select 1)', await storage.db.one('select 1 as x'));

const q = async (sql: string) => (await pool.query(sql)).rows;
log('3 tables per schema', await q(`select table_schema, count(*)::int n from information_schema.tables where table_schema not in ('pg_catalog','information_schema') group by 1 order by 1`));
log('   mastra table sample', (await q(`select table_name from information_schema.tables where table_schema='mastra' order by 1 limit 50`)).map(r => r.table_name).join(','));
log('   extensions', await q(`select e.extname, n.nspname schema, e.extversion from pg_extension e join pg_namespace n on n.oid=e.extnamespace`));

// 4. our ORM + Mastra memory on same pool
await db.insert(tasks).values({ id: 't1', title: 'Write spec', threadId: 'task_t1', meta: { dept: 'eng' } });
const mem = await lead.getMemory();
await mem!.createThread({ resourceId: 'owner', threadId: 'task_t1', title: 'Task t1', metadata: { taskId: 't1' } });
const row = await db.query.tasks.findFirst({ where: eq(tasks.id, 't1') });
log('4 drizzle row + mastra thread', { row: row?.title, thread: (await mem!.getThreadById({ threadId: 'task_t1' }))?.metadata });

// 5. PgVector with schemaName (separate pool) — does it touch extension/search_path?
const vec = new PgVector({ id: 'vec', connectionString: url, schemaName: 'mastra', pgPoolOptions: { max: 2 } });
await vec.createIndex({ indexName: 'spike_embeddings', dimension: 4, metric: 'cosine', indexConfig: { type: 'hnsw' } });
await vec.upsert({ indexName: 'spike_embeddings', vectors: [[0.1, 0.2, 0.3, 0.4]], metadata: [{ k: 'v' }] });
const res = await vec.query({ indexName: 'spike_embeddings', queryVector: [0.1, 0.2, 0.3, 0.4], topK: 1 });
log('5 PgVector hnsw query score', res[0]?.score);
log('   vector table schema', await q(`select table_schema, table_name from information_schema.tables where table_name like 'spike_embeddings%'`));
log('   extensions after PgVector', await q(`select e.extname, n.nspname schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace`));
const c = await pool.connect();
log('   our pool search_path', (await c.query('show search_path')).rows[0]);
c.release();
log('6 pool stats total/idle/waiting', [pool.totalCount, pool.idleCount, pool.waitingCount]);

await vec.disconnect();
await mastra.shutdown({ drainTimeout: 200 });
await storage.close(); // should NOT end caller pool
log('7 our pool still usable after store.close()', (await pool.query('select 1 as ok')).rows[0]);
await pool.end();
process.exit(0);
