import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { SettingsSchema, UpdateSettingsInputSchema } from '@superagent/shared';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const getSettings = createRoute({
  method: 'get',
  path: '/settings',
  tags: ['settings'],
  summary: 'Server settings',
  description: 'Model roles (default, fast, embedding), timezone and background-task concurrency.',
  responses: {
    200: { description: 'Current settings', content: { 'application/json': { schema: SettingsSchema } } },
  },
});

const updateSettings = createRoute({
  method: 'patch',
  path: '/settings',
  tags: ['settings'],
  summary: 'Update settings',
  description:
    'Partial update. Model roles take effect on the next call; `null` clears a role. ' +
    'Concurrency limits apply after a restart.',
  request: {
    body: { required: true, content: { 'application/json': { schema: UpdateSettingsInputSchema } } },
  },
  responses: {
    200: { description: 'Updated settings', content: { 'application/json': { schema: SettingsSchema } } },
    400: problemResponse('Invalid timezone, or a model reference to an unknown provider or model'),
  },
});

export function registerSettingsRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(getSettings, (c) => c.json(deps.settings.get(), 200));

  v1.openapi(updateSettings, async (c) => {
    const next = await deps.settings.update(c.req.valid('json'), (ref, label, kind) =>
      deps.providers.assertUsable(ref, label, kind),
    );
    deps.logger.info('Settings updated', { keys: Object.keys(c.req.valid('json')) });
    return c.json(next, 200);
  });
}
