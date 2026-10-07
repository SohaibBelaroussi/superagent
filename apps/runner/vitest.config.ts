import { defineConfig } from 'vitest/config';

// Unit tests only: the runner against real Docker is exercised by the API's integration suite.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
