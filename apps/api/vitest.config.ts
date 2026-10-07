import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    env: { MASTRA_TELEMETRY_DISABLED: 'true' },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 20_000 },
      },
      {
        // Real Postgres (pgvector) in a throwaway container; each test file gets its own database.
        extends: true,
        test: {
          name: 'int',
          include: ['test/int/**/*.int.test.ts'],
          globalSetup: ['test/int/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        // Runs against a live stack: `pnpm stack:up` first. Reads the admin token from the root .env.
        extends: true,
        test: { name: 'e2e', include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 30_000 },
      },
    ],
  },
});
