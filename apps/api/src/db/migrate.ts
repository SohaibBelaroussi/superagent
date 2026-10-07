import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

/**
 * Finds apps/api/drizzle from wherever the code runs: src/db in development, dist/ when bundled.
 * The migration journal stays in Drizzle's default `drizzle` schema (an `app` journal breaks the first run).
 */
export function findMigrationsFolder(start: string = import.meta.dirname): string {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No drizzle migrations folder found above ${start}`);
    dir = parent;
  }
}

export async function runMigrations(db: Db, migrationsFolder = findMigrationsFolder()): Promise<void> {
  await migrate(db, { migrationsFolder });
}
