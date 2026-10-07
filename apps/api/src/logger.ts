import { PinoLogger } from '@mastra/loggers';
import type { Config } from './config';

/** Fields that may carry credentials if an object containing them is ever logged. */
const REDACT_PATHS = [
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'token',
  '*.token',
];

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): PinoLogger {
  return new PinoLogger({
    name: 'superagent',
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Single-line JSON in production for log collectors, readable output in development.
    prettyPrint: config.NODE_ENV === 'development',
  });
}
