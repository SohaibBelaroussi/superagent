import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The admin token comes from the repository's .env, as for the API's e2e suite.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Browser tests against a running stack: the API image serving the built app (`pnpm stack:up`, or the
 * release images in CI). PW_CHANNEL=msedge or chrome uses an installed browser instead of Playwright's.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL } }],
});
