import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap';
import { ConfigError, loadConfig } from './config';
import { loadDotEnv } from './env';
import { APP_VERSION } from './version';

loadDotEnv();

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const system = await bootstrap(config);
const { logger, mastra } = system;

const server = serve({ fetch: system.app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  logger.info(`superagent ${APP_VERSION} listening on http://${info.address}:${info.port}`);
}) as Server;

// Workers (scheduler, background tasks) only run when started explicitly with the Hono adapter.
await mastra.startWorkers();
await mastra.restartAllActiveWorkflowRuns();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out, exiting');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop accepting connections; long-lived streams (SSE) are cut after a short grace period.
  server.close();
  setTimeout(() => server.closeAllConnections(), 2_000).unref();
  try {
    await system.close(Math.min(5_000, config.SHUTDOWN_TIMEOUT_MS / 2));
  } catch (error) {
    logger.error('Error during shutdown', { error });
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
