import type { Mastra } from '@mastra/core/mastra';
import { createAuthMiddleware } from '@mastra/hono';
import type { MiddlewareHandler } from 'hono';
import { ADMIN_TOKEN_ID, type AuthUser } from '../auth/tokens';
import { ApiError, problem } from './problem';
import type { AppEnv } from './types';

/**
 * Guards our own routes with the same auth provider as Mastra's /api routes.
 * Native Hono routes are public by default, so every /v1 route must sit behind this.
 * Mastra's 401/403 bodies are rewritten as problem+json for consistency.
 */
export function requireAuth(
  mastra: Mastra,
  publicPaths: ReadonlySet<string> = new Set(),
): MiddlewareHandler<AppEnv> {
  const mastraAuth = createAuthMiddleware({ mastra });
  return async (c, next) => {
    if (publicPaths.has(c.req.path)) return next();
    const result = await mastraAuth(c, next);
    if (result instanceof Response && (result.status === 401 || result.status === 403)) {
      const body = (await result.json().catch(() => ({}))) as { error?: string };
      return problem(c, result.status, {
        code: result.status === 401 ? 'unauthorized' : 'forbidden',
        detail: body.error ?? 'A valid API token is required',
      });
    }
    return result;
  };
}

type RequestContextCarrier = { get(key: 'requestContext'): AppEnv['Variables']['requestContext'] };

/** The authenticated user, as set by the auth provider on Mastra's request context. */
export function currentUser(c: RequestContextCarrier): AuthUser {
  const user = c.get('requestContext').get('mastra__user') as AuthUser | undefined;
  if (!user) throw new Error('currentUser() called on a route without requireAuth');
  return user;
}

/** Restricts a route to the bootstrap admin token (403 otherwise). */
export function requireAdminToken(c: RequestContextCarrier): AuthUser {
  const user = currentUser(c);
  if (user.tokenId !== ADMIN_TOKEN_ID) {
    throw new ApiError(403, 'admin_token_required', 'This action requires the admin token');
  }
  return user;
}
