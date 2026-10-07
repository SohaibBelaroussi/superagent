// Must stay the first import: loads .env before any library module evaluates.
import './load-env';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { bootstrap, type System } from './bootstrap';
import { ConfigError, loadConfig } from './config';
import { APP_VERSION } from './version';

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

let system: System | undefined;
let server: Server | undefined;
let shuttingDown = false;

// Registered before boot so a signal during startup (migrations, storage init) still exits cleanly.
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

system = await bootstrap(config);
const { logger, mastra } = system;

server = serve({ fetch: system.app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  logger.info(`superagent ${APP_VERSION} listening on http://${info.address}:${info.port}`);
}) as Server;
system.injectWebSocket(server);

// Workers (scheduler, background tasks) only run when started explicitly with the Hono adapter.
await mastra.startWorkers();
await mastra.restartAllActiveWorkflowRuns();

/**
 * Graceful shutdown, bounded by SHUTDOWN_TIMEOUT_MS (keep it below compose's stop_grace_period):
 * 1. stop accepting connections and let in-flight requests finish (half the budget),
 * 2. cut whatever is still open (SSE streams),
 * 3. drain Mastra (runs, background tasks, workers) and close the database pool.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  system?.logger.info('Shutting down', { signal });
  const forceExit = setTimeout(() => {
    system?.logger.error('Shutdown timed out, exiting');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) await closeServer(server, Math.floor(config.SHUTDOWN_TIMEOUT_MS / 2));
    if (system) await system.close(Math.floor(config.SHUTDOWN_TIMEOUT_MS / 4));
  } catch (error) {
    system?.logger.error('Error during shutdown', { error });
  }
  clearTimeout(forceExit);
  process.exit(0);
}

/** Resolves once every connection has closed; connections still open after `graceMs` are cut. */
function closeServer(httpServer: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => httpServer.closeAllConnections(), graceMs);
    cut.unref();
    httpServer.close(() => {
      clearTimeout(cut);
      resolve();
    });
  });
}
