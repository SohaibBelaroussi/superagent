import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: { MASTRA_TELEMETRY_DISABLED: 'true' },
  },
});
