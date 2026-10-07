import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { MeSchema } from '@superagent/shared';
import { currentUser } from '../../http/auth';
import type { AppEnv } from '../../http/types';

const getMe = createRoute({
  method: 'get',
  path: '/me',
  tags: ['auth'],
  summary: 'Who the presented token belongs to',
  responses: {
    200: {
      description: 'The authenticated owner and token',
      content: { 'application/json': { schema: MeSchema } },
    },
  },
});

export function registerMeRoutes(v1: OpenAPIHono<AppEnv>): void {
  v1.openapi(getMe, (c) => {
    const user = currentUser(c);
    return c.json({ id: user.id, name: user.name, token: { id: user.tokenId, name: user.tokenName } }, 200);
  });
}
