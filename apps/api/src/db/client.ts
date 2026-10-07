import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Config } from '../config';
import * as schema from './schema';

/** One pool for the whole process, shared by Drizzle and Mastra's PostgresStore. */
export function createPool(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
}

export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema });
}

export type Db = ReturnType<typeof createDb>;
