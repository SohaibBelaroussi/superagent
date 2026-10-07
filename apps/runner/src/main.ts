import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { createRunner, loadRunnerConfig, RunnerConfigError } from './index';

/** Development: the repo's .env (production gets its environment from compose). */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  let dir = process.cwd();
  for (;;) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadDotEnv();
let config: ReturnType<typeof loadRunnerConfig>;
try {
  config = loadRunnerConfig();
} catch (error) {
  if (error instanceof RunnerConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const runner = createRunner(config);
const server = serve(
  { fetch: runner.app.fetch, hostname: config.RUNNER_HOST, port: config.RUNNER_PORT },
  (info) =>
    console.log(JSON.stringify({ level: 'info', msg: `runner listening on ${info.address}:${info.port}` })),
);
runner.start();

// Sandboxes outlive the runner: stopping it just stops serving.
const shutdown = () => {
  runner.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
