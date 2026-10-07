import { z } from 'zod';

const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

const duration = (fallback: number, min = 1_000) => z.coerce.number().int().min(min).default(fallback);

export const RunnerConfigSchema = z.object({
  /** Shared with the API, which sends it as a bearer token. */
  RUNNER_TOKEN: z
    .string()
    .min(32, 'must be at least 32 characters')
    .refine((token) => !token.startsWith('change-me'), 'replace the example value with a generated one'),
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
  /** The browser image (decision D34): Chromium, one container per task for agents granted the browser. */
  RUNNER_BROWSER_IMAGE: z.string().regex(IMAGE_REF).default('superagent-browser:1'),
  /** The internal network browsers join: its only way out is the egress proxy. */
  RUNNER_BROWSER_NETWORK: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/)
    .default('superagent-browsers'),
  /** The egress proxy browsers go out through. Empty: no proxy (only for a closed test network). */
  RUNNER_BROWSER_PROXY: z.string().default('http://egress:3128'),
  /** Hosts browsers reach without the proxy, ;-separated (tests only). */
  RUNNER_BROWSER_BYPASS: z
    .string()
    .regex(/^[a-zA-Z0-9.;:*-]*$/)
    .default(''),
  /**
   * The seccomp profile that lets Chromium sandbox its renderers (`auto`: the one shipped with the
   * runner). `none`: Docker's default profile, and Chromium runs without its own sandbox.
   */
  RUNNER_BROWSER_SECCOMP: z.string().default('auto'),
  RUNNER_BROWSER_MEMORY_MB: z.coerce.number().int().min(256).default(2048),
  /** Chromium runs a few hundred threads; each counts against this. */
  RUNNER_BROWSER_PIDS_LIMIT: z.coerce.number().int().min(256).default(1024),
  /** Browsers running at once; at the limit, the least recently used idle one is stopped first. */
  RUNNER_MAX_BROWSERS: z.coerce.number().int().min(1).default(4),
  /** A browser nobody is connected to for this long is stopped (its identity's cookies are saved). */
  RUNNER_BROWSER_IDLE_STOP_MS: duration(10 * 60_000, 100),
  /** Identity profiles are volumes named <this>-<identity id>. */
  RUNNER_IDENTITY_VOLUME_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,30}$/)
    .default('superagent-identity'),
  /** The image stdio MCP servers run in (decision D36): Node, Python and uv. */
  RUNNER_MCP_IMAGE: z.string().regex(IMAGE_REF).default('superagent-mcp:1'),
  /**
   * The internal network the egress proxy joins for MCP servers. Each package gets an internal network
   * of its own, which the runner has the proxy join too: its only way out, and no way to other packages.
   */
  RUNNER_MCP_NETWORK: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/)
    .default('superagent-mcp'),
  /** The egress proxy MCP servers and package installs go out through. Empty: none (tests). */
  RUNNER_MCP_PROXY: z.string().default('http://egress:3128'),
  /** A package's files and installs are in <this>-<id>, its servers' writable data in <this>-data-<id>. */
  RUNNER_MCP_VOLUME_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,30}$/)
    .default('superagent-mcp'),
  RUNNER_MCP_MEMORY_MB: z.coerce.number().int().min(64).default(512),
  RUNNER_MCP_PIDS_LIMIT: z.coerce.number().int().min(32).default(256),
  /** Packages running at once; at the limit, the least recently used idle one is stopped first. */
  RUNNER_MAX_MCP: z.coerce.number().int().min(1).default(8),
  /** A package nobody has called for this long is stopped (its servers start again on the next call). */
  RUNNER_MCP_IDLE_STOP_MS: duration(10 * 60_000, 100),
  /**
   * How long installing one server's package may take. The API waits for each install in one request,
   * and Node's fetch gives up on an answer after 300 s: keep it under that.
   */
  RUNNER_MCP_INSTALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(270_000).default(240_000),
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
  /** The largest file a sandbox may write (RLIMIT_FSIZE). */
  RUNNER_FILE_LIMIT_MB: z.coerce.number().int().min(1).default(2048),
  /** Commands and writes are refused while the workspaces' disk has less free space than this. */
  RUNNER_MIN_FREE_MB: z.coerce.number().int().min(0).default(2048),
  /** Sandboxes running at once; at the limit, the least recently used idle one is stopped first. */
  RUNNER_MAX_RUNNING: z.coerce.number().int().min(1).default(8),
  /** How long one file operation may take. */
  RUNNER_FS_TIMEOUT_MS: duration(30_000, 100),
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
