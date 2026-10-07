import { z } from 'zod';

const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

const duration = (fallback: number, min = 1_000) => z.coerce.number().int().min(min).default(fallback);

export const RunnerConfigSchema = z.object({
  /** Shared with the API, which sends it as a bearer token. */
  RUNNER_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().min(0).max(65_535).default(4120),
  /** The named volume holding every task's folder, tasks/<id>. A sandbox mounts only its own. */
  RUNNER_WORKSPACES_VOLUME: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/)
    .default('superagent-workspaces'),
  /** Profile -> image, as JSON. Only these images run, and the runner never pulls one. */
  RUNNER_IMAGES: z
    .string()
    .default('{"dev":"superagent-sandbox-dev:1"}')
    .transform((raw, ctx) => {
      try {
        return z
          .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.string().regex(IMAGE_REF))
          .refine((images) => Object.keys(images).length > 0, 'at least one profile')
          .parse(JSON.parse(raw));
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: `must map profiles to image names: ${String(error)}` });
        return z.NEVER;
      }
    }),
  /** Labels this runner's containers, so two runners (say, tests) never touch each other's. */
  RUNNER_NAME_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,20}$/)
    .default('sa-task'),
  /** A sandbox with no command or file operation for this long, and nothing running, is stopped. */
  RUNNER_IDLE_STOP_MS: duration(15 * 60_000, 100),
  /** A stopped sandbox is removed after this long (its files stay). */
  RUNNER_REMOVE_AFTER_MS: duration(7 * 24 * 60 * 60_000, 100),
  RUNNER_REAP_INTERVAL_MS: duration(60_000, 100),
  RUNNER_MEMORY_MB: z.coerce.number().int().min(64).default(1024),
  RUNNER_CPUS: z.coerce.number().min(0.1).max(64).default(1),
  RUNNER_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),
  /** /tmp is a tmpfs (the root filesystem is read-only); it counts against the memory limit. */
  RUNNER_TMP_MB: z.coerce.number().int().min(16).default(512),
  /** For commands that don't set their own timeout. */
  RUNNER_EXEC_TIMEOUT_MS: duration(120_000, 100),
  /** Output kept per stream (the end of it, like a terminal's scrollback). */
  RUNNER_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export class RunnerConfigError extends Error {}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = RunnerConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new RunnerConfigError(`Invalid runner configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
