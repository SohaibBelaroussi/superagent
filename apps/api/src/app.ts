import { MastraServer } from '@mastra/hono';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createErrorHandler, notFound } from './http/problem';
import { requestLog } from './http/request-log';
import type { AppDeps, AppEnv } from './http/types';
import { createV1Router, V1_PREFIX } from './routes/v1';

/**
 * Route map:
 *   /health, /ready  public liveness and readiness
 *   /api/*           Mastra's built-in routes (agents, threads, memory, schedules...), token auth per route
 *   /v1/*            our control plane, token auth via requireAuth
 */
export async function createApp(deps: AppDeps): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFound);
  app.use('*', requestLog(deps.logger));
  if (deps.config.CORS_ORIGINS.length > 0) {
    app.use('*', cors({ origin: deps.config.CORS_ORIGINS, credentials: true, maxAge: 600 }));
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ status: 'ready', checks: { database: 'ok' } });
    } catch (error) {
      deps.logger.warn('Readiness check failed', { error });
      return c.json({ status: 'unavailable', checks: { database: 'error' } }, 503);
    }
  });

  await new MastraServer({
    app,
    mastra: deps.mastra,
    openapiPath: '/openapi.json',
    bodyLimitOptions: {
      maxSize: 4 * 1024 * 1024,
      onError: () => ({ error: 'Request body exceeds 4 MiB' }),
    },
  }).init();

  app.route(V1_PREFIX, createV1Router(deps));
  return app;
}
