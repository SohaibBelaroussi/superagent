import type { IMastraLogger } from '@mastra/core/logger';
import type { MiddlewareHandler } from 'hono';

const QUIET_PATHS = new Set(['/health', '/ready']);

/** The API's requests; the rest is the web app's files, logged only at debug level. */
const isApiPath = (path: string) =>
  path === '/api' || path.startsWith('/api/') || path === '/v1' || path.startsWith('/v1/');

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
    if (QUIET_PATHS.has(c.req.path) || (!isApiPath(c.req.path) && c.res.status < 400)) {
      logger.debug('request', fields);
    } else logger.info('request', fields);
  };
}
