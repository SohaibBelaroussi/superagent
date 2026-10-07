import { MastraServer } from '@mastra/hono';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createErrorHandler, notFound, problem } from './http/problem';
import { requestLog } from './http/request-log';
import type { AppDeps, AppEnv } from './http/types';
import { createV1Router, V1_PREFIX } from './routes/v1';
import { isUpload, isUploadBeforeAuth, MAX_UPLOAD_BYTES } from './routes/v1/knowledge';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

  // Before MastraServer.init(): Mastra's context middleware parses every JSON body before auth,
  // so without a global cap an unauthenticated client could make the server buffer huge payloads.
  // Only a multipart upload with a declared length may be larger here: it is neither parsed by Mastra
  // nor read to be counted before auth (see isUploadBeforeAuth).
  const defaultLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => problem(c, 413, { code: 'payload_too_large', detail: 'Request body exceeds 4 MiB' }),
  });
  const uploadLimit = bodyLimit({
    maxSize: MAX_UPLOAD_BYTES,
    onError: (c) => problem(c, 413, { code: 'payload_too_large', detail: 'Uploads are limited to 20 MiB' }),
  });
  const undeclaredUploadLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      problem(c, 413, {
        code: 'payload_too_large',
        detail: 'Uploads larger than 4 MiB must declare their Content-Length (browsers and curl do)',
      }),
  });
  app.use('*', (c, next) => {
    if (isUploadBeforeAuth(c)) return uploadLimit(c, next);
    return isUpload(c) ? undeclaredUploadLimit(c, next) : defaultLimit(c, next);
  });

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
      maxSize: MAX_BODY_BYTES,
      onError: () => ({ error: 'Request body exceeds 4 MiB' }),
    },
  }).init();

  app.route(V1_PREFIX, createV1Router(deps));
  return app;
}
