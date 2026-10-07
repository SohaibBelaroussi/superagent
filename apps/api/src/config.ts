import { z } from 'zod';

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be an IANA timezone such as Asia/Qatar' },
);

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
