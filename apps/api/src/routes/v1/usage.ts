import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { UsageQuerySchema, UsageReportSchema } from '@superagent/shared';
import type { AppDeps, AppEnv } from '../../http/types';

const getUsage = createRoute({
  method: 'get',
  path: '/usage',
  tags: ['usage'],
  summary: 'Tokens and cost, grouped',
  description:
    'Every model call, from the traces (decision D40): grouped by department (calls outside tasks under ' +
    "a null key), task, agent, model or day (in the owner's timezone), over an optional period. Costs " +
    'come from model prices (PUT /v1/providers/{id}/prices) at the time of each call.',
  request: { query: UsageQuerySchema },
  responses: {
    200: { description: 'The report', content: { 'application/json': { schema: UsageReportSchema } } },
  },
});

export function registerUsageRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(getUsage, async (c) => c.json(await deps.usage.report(c.req.valid('query')), 200));
}
