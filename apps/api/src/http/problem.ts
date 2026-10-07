// RFC 9457 problem details for every /v1 error response.
import type { Hook } from '@hono/zod-openapi';
import type { IMastraLogger } from '@mastra/core/logger';
import { type Problem, ProblemSchema } from '@superagent/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types';

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Thrown by route handlers for expected failures. Rendered as problem+json by onError. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function problem(
  c: Context,
  status: ContentfulStatusCode,
  fields: Omit<Partial<Problem>, 'status'> = {},
): Response {
  const body: Problem = {
    type: 'about:blank',
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    ...fields,
  };
  return c.body(JSON.stringify(body), status, { 'content-type': 'application/problem+json' });
}

/** OpenAPI response entry for an error status. */
export function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ProblemSchema } } };
}

/** Turns zod validation failures from @hono/zod-openapi routes into 400 problem+json. */
export const validationHook: Hook<unknown, AppEnv, string, unknown> = (result, c) => {
  if (result.success) return;
  return problem(c, 400, {
    title: 'Invalid request',
    code: 'validation_failed',
    errors: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
};

export const notFound: NotFoundHandler = (c) =>
  problem(c, 404, { code: 'not_found', detail: `No route for ${c.req.method} ${c.req.path}` });

export function createErrorHandler(logger: IMastraLogger): ErrorHandler {
  return (error, c) => {
    if (error instanceof ApiError)
      return problem(c, error.status, { code: error.code, detail: error.message });
    if (error instanceof HTTPException) {
      return problem(c, error.status as ContentfulStatusCode, { detail: error.message || undefined });
    }
    logger.error('Unhandled error', { method: c.req.method, path: c.req.path, error });
    return problem(c, 500, { code: 'internal_error' });
  };
}
