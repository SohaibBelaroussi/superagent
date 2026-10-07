import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CreatedTokenSchema,
  CreateTokenInputSchema,
  TokenListSchema,
  type TokenRecord,
} from '@superagent/shared';
import type { ApiTokenRow } from '../../db/schema';
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

const listTokens = createRoute({
  method: 'get',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'List API tokens',
  responses: {
    200: {
      description: 'All tokens, newest first',
      content: { 'application/json': { schema: TokenListSchema } },
    },
  },
});

const createToken = createRoute({
  method: 'post',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'Create an API token',
  description: 'Returns the secret token once. Store it on the device that will use it.',
  request: { body: { required: true, content: { 'application/json': { schema: CreateTokenInputSchema } } } },
  responses: {
    201: { description: 'Token created', content: { 'application/json': { schema: CreatedTokenSchema } } },
    400: problemResponse('Invalid request'),
  },
});

const revokeToken = createRoute({
  method: 'delete',
  path: '/tokens/{id}',
  tags: ['tokens'],
  summary: 'Revoke an API token',
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: 'Token revoked' },
    404: problemResponse('No token with this id'),
  },
});

export function registerTokenRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(listTokens, async (c) => {
    const rows = await deps.tokens.list();
    return c.json({ items: rows.map(toTokenRecord) }, 200);
  });

  v1.openapi(createToken, async (c) => {
    const { name } = c.req.valid('json');
    const { token, record } = await deps.tokens.create(name);
    deps.logger.info('API token created', { tokenId: record.id, name: record.name });
    return c.json({ token, record: toTokenRecord(record) }, 201);
  });

  v1.openapi(revokeToken, async (c) => {
    const { id } = c.req.valid('param');
    const found = await deps.tokens.revoke(id);
    if (!found) throw new ApiError(404, 'token_not_found', `No token with id ${id}`);
    deps.logger.info('API token revoked', { tokenId: id });
    return c.body(null, 204);
  });
}
