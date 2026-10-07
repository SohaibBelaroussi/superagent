import { z } from 'zod';
import { isValidTimezone } from './util/text';

const timezone = z
  .string()
  .refine(isValidTimezone, { message: 'must be an IANA timezone such as Asia/Qatar' });

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4111),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().refine((url) => /^postgres(ql)?:\/\//.test(url) && URL.canParse(url), {
    message:
      'must be a valid postgres:// URL; percent-encode special characters in the password, ' +
      'or use a password made of letters, digits, - and _',
  }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SUPERAGENT_ADMIN_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  SUPERAGENT_ENCRYPTION_KEY: z.string().refine((key) => Buffer.from(key, 'base64').length === 32, {
    message:
      'must be 32 random bytes, base64-encoded: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  }),
  STUDIO_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  DEFAULT_TIMEZONE: timezone.default('Asia/Qatar'),
  SEARXNG_URL: z.url().default('http://127.0.0.1:8888'),
  CRAWL4AI_URL: z.url().default('http://127.0.0.1:11235'),
  CRAWL4AI_API_TOKEN: z.string().min(16).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates configuration. Empty strings count as unset, so `KEY=` in .env behaves like a missing key. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
