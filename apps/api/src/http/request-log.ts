import type { IMastraLogger } from '@mastra/core/logger';
import type { MiddlewareHandler } from 'hono';

const QUIET_PATHS = new Set(['/health', '/ready']);

/** One log line per request. Logs the path only: query strings can carry `?apiKey=` tokens. */
export function requestLog(logger: IMastraLogger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    };
    if (QUIET_PATHS.has(c.req.path)) logger.debug('request', fields);
    else logger.info('request', fields);
  };
}
