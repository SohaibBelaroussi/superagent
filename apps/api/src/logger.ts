import { PinoLogger } from '@mastra/loggers';
import type { Config } from './config';

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): PinoLogger {
  return new PinoLogger({
    name: 'superagent',
    level: config.LOG_LEVEL,
    // Single-line JSON in production for log collectors, readable output in development.
    prettyPrint: config.NODE_ENV === 'development',
  });
}
