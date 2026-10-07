import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser connection string; tests create their own databases from it. */
    pgAdminUrl: string;
  }
}

/** Starts one pgvector Postgres for the whole run, unless TEST_DATABASE_URL points at an existing server. */
export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    project.provide('pgAdminUrl', external);
    return;
  }
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
