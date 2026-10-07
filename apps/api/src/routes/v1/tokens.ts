import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CreatedTokenSchema,
  CreateTokenInputSchema,
  TokenListSchema,
  type TokenRecord,
} from '@superagent/shared';
import { ADMIN_TOKEN_ID } from '../../auth/tokens';
import type { ApiTokenRow } from '../../db/schema';
import { currentUser, requireAdminToken } from '../../http/auth';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

function toTokenRecord(row: ApiTokenRow): TokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const adminOnly = problemResponse('Only the admin token can manage API tokens');

const listTokens = createRoute({
  method: 'get',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'List API tokens',
  description: 'Requires the admin token.',
  responses: {
    200: {
      description: 'All tokens, newest first',
      content: { 'application/json': { schema: TokenListSchema } },
    },
    403: adminOnly,
  },
});

const createToken = createRoute({
  method: 'post',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'Create an API token',
  description:
    'Requires the admin token, so a stolen device token cannot mint replacements. ' +
    'Returns the secret token once; store it on the device that will use it.',
  request: { body: { required: true, content: { 'application/json': { schema: CreateTokenInputSchema } } } },
  responses: {
    201: { description: 'Token created', content: { 'application/json': { schema: CreatedTokenSchema } } },
    400: problemResponse('Invalid request'),
    403: adminOnly,
  },
});

const revokeToken = createRoute({
  method: 'delete',
  path: '/tokens/{id}',
  tags: ['tokens'],
  summary: 'Revoke an API token',
  description: 'The admin token can revoke any token; a device token can revoke only itself (sign out).',
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: 'Token revoked' },
    403: problemResponse('A device token can only revoke itself'),
    404: problemResponse('No token with this id'),
  },
});

export function registerTokenRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(listTokens, async (c) => {
    requireAdminToken(c);
    const rows = await deps.tokens.list();
    return c.json({ items: rows.map(toTokenRecord) }, 200);
  });

  v1.openapi(createToken, async (c) => {
    requireAdminToken(c);
    const { name } = c.req.valid('json');
    const { token, record } = await deps.tokens.create(name);
    deps.logger.info('API token created', { tokenId: record.id, name: record.name });
    return c.json({ token, record: toTokenRecord(record) }, 201);
  });

  v1.openapi(revokeToken, async (c) => {
    const { id } = c.req.valid('param');
    const caller = currentUser(c);
    if (caller.tokenId !== ADMIN_TOKEN_ID && caller.tokenId !== id) {
      throw new ApiError(403, 'forbidden', 'A device token can only revoke itself');
    }
    const found = await deps.tokens.revoke(id);
    if (!found) throw new ApiError(404, 'token_not_found', `No token with id ${id}`);
    deps.logger.info('API token revoked', { tokenId: id, by: caller.tokenId });
    return c.body(null, 204);
  });
}
