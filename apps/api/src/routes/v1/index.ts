import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { requireAuth } from '../../http/auth';
import { problem, validationHook } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import { APP_VERSION } from '../../version';
import { registerMeRoutes } from './me';
import { registerOrgRoutes } from './org';
import { registerProviderRoutes } from './providers';
import { registerSettingsRoutes } from './settings';
import { registerTaskRoutes } from './tasks';
import { registerTokenRoutes } from './tokens';

export const V1_PREFIX = '/v1';

/** Our control-plane API. Everything here requires a token, except the API docs outside production. */
export function createV1Router(deps: AppDeps): OpenAPIHono<AppEnv> {
  const v1 = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  const docsArePublic = deps.config.NODE_ENV !== 'production';
  const publicPaths = new Set(docsArePublic ? [`${V1_PREFIX}/openapi.json`, `${V1_PREFIX}/docs`] : []);

  v1.use('*', requireAuth(deps.mastra, publicPaths));
  v1.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => problem(c, 413, { code: 'payload_too_large', detail: 'Request body exceeds 1 MiB' }),
    }),
  );

  registerMeRoutes(v1);
  registerTokenRoutes(v1, deps);
  registerProviderRoutes(v1, deps);
  registerSettingsRoutes(v1, deps);
  registerOrgRoutes(v1, deps);
  registerTaskRoutes(v1, deps);

  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' });
  v1.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Superagent API',
      version: APP_VERSION,
      description: 'Control plane for the superagent organization. Mastra runtime routes live under /api.',
    },
    servers: [{ url: V1_PREFIX }],
    security: [{ bearer: [] }],
  });
  if (docsArePublic)
    v1.get('/docs', Scalar({ url: `${V1_PREFIX}/openapi.json`, pageTitle: 'Superagent API' }));

  return v1;
}
