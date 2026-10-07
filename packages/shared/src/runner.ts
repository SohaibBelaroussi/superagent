import { z } from 'zod';

/**
 * The runner's internal API (decision D10): the only service that talks to Docker. The API calls it to
 * keep one sandbox container per task, run commands in it and read and write its files. Not part of
 * /v1: clients never see it.
 */

/** Task ids are UUIDs: they name containers and workspace folders, so nothing else is accepted. */
export const RunnerTaskIdSchema = z.uuid();

/** Sandbox profiles name an allowlisted image (`dev`: node, python, git). */
export const SandboxProfileSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .default('dev');

export const RunnerSandboxSchema = z.object({
  taskId: z.uuid(),
  container: z.string(),
  profile: z.string(),
  image: z.string(),
  state: z.enum(['running', 'stopped']),
  createdAt: z.iso.datetime(),
  /** The last command or file operation, when the runner saw one since it started. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type RunnerSandbox = z.infer<typeof RunnerSandboxSchema>;

export const RunnerSandboxListSchema = z.object({ items: z.array(RunnerSandboxSchema) });

export const EnsureSandboxInputSchema = z.object({ profile: SandboxProfileSchema });
export const EnsureSandboxResultSchema = RunnerSandboxSchema.extend({
  /** created: a fresh container; connected: the task's existing one (started again if it was stopped). */
  outcome: z.enum(['created', 'connected']),
});
export type EnsureSandboxResult = z.infer<typeof EnsureSandboxResultSchema>;

export const ExecInputSchema = z.object({
  profile: SandboxProfileSchema,
  command: z.string().min(1).max(100_000),
  /** Relative to /workspace, or absolute inside the container. */
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32_768)).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30 * 60_000)
    .optional(),
  /** Start it and return at once; read its output later through the processes routes. */
  background: z.boolean().optional(),
});
export type ExecInput = z.input<typeof ExecInputSchema>;

export const ExecResultSchema = z.object({
  execId: z.string(),
  /** null for a background command that is still running. */
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  timedOut: z.boolean(),
  killed: z.boolean(),
  durationMs: z.number(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const ProcessInfoSchema = z.object({
  execId: z.string(),
  command: z.string(),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
});
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>;
export const ProcessListSchema = z.object({ items: z.array(ProcessInfoSchema) });

/**
 * A background process and a slice of its output: the bytes from the offsets asked for (at most
 * `maxBytes` each), and each stream's total size, so the caller reads on from where it stopped.
 */
export const ProcessStatusSchema = ProcessInfoSchema.extend({
  stdoutSize: z.number(),
  stderrSize: z.number(),
  stdoutBase64: z.string(),
  stderrBase64: z.string(),
});
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

/** What the runner can do right now: reach Docker, which profiles' images are built, start browsers. */
export const RunnerReadySchema = z.object({
  docker: z.boolean(),
  images: z.record(z.string(), z.boolean()),
  /** The browser image is built and the browsers network exists. */
  browser: z.boolean(),
  /** The MCP image is built and the MCP network exists. */
  mcp: z.boolean(),
});
export type RunnerReady = z.infer<typeof RunnerReadySchema>;

const path = z.string().min(1).max(4096);
export const FsRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('read'),
    path,
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024)
      .optional(),
  }),
  z.object({
    op: z.literal('write'),
    path,
    contentBase64: z.string(),
    mode: z.enum(['overwrite', 'create', 'append']).default('overwrite'),
    /** Refuse (stale) when the file changed since this modification time (ms since the epoch). */
    expectedMtimeMs: z.number().optional(),
  }),
  z.object({
    op: z.literal('list'),
    path,
    maxDepth: z.number().int().min(1).max(20).default(1),
    limit: z.number().int().min(1).max(10_000).default(2_000),
  }),
  z.object({ op: z.literal('stat'), path }),
  z.object({ op: z.literal('mkdir'), path, recursive: z.boolean().default(true) }),
  z.object({
    op: z.literal('remove'),
    path,
    kind: z.enum(['file', 'directory', 'any']).default('any'),
    recursive: z.boolean().default(false),
    force: z.boolean().default(false),
  }),
  z.object({
    op: z.enum(['copy', 'move']),
    path,
    dest: path,
    overwrite: z.boolean().default(true),
  }),
]);
export type FsRequest = z.input<typeof FsRequestSchema>;
/** A file operation with its defaults applied. */
export type FsOperation = z.output<typeof FsRequestSchema>;

export const FsEntrySchema = z.object({
  /** Relative to the listed folder. */
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number(),
  modifiedAt: z.iso.datetime(),
  /** For a symlink: where it points. */
  target: z.string().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsStatSchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'directory', 'other']),
  size: z.number(),
  modifiedAt: z.iso.datetime(),
  /** Modification time in ms since the epoch, for expectedMtimeMs. */
  mtimeMs: z.number(),
  /** A regular file whose first bytes include NUL: not text. */
  binary: z.boolean(),
});
export type FsStat = z.infer<typeof FsStatSchema>;

export const FsResultSchema = z.object({
  /** read */
  contentBase64: z.string().optional(),
  size: z.number().optional(),
  truncated: z.boolean().optional(),
  /** list */
  entries: z.array(FsEntrySchema).optional(),
  /** stat */
  stat: FsStatSchema.optional(),
});
export type FsResult = z.infer<typeof FsResultSchema>;

/** A task's browser container (decision D34). */
export const RunnerBrowserSchema = z.object({
  taskId: z.uuid(),
  container: z.string(),
  /** The identity whose profile it uses, if any. */
  identityId: z.uuid().nullable(),
  state: z.enum(['running', 'stopped']),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** Connections open to it right now. */
  connections: z.number().int(),
});
export type RunnerBrowser = z.infer<typeof RunnerBrowserSchema>;
export const RunnerBrowserListSchema = z.object({ items: z.array(RunnerBrowserSchema) });

export const EnsureBrowserInputSchema = z.object({ identityId: z.uuid().optional() });
export const EnsureBrowserResultSchema = RunnerBrowserSchema.extend({
  outcome: z.enum(['created', 'connected']),
  /**
   * A single-use ticket for the DevTools connection, `GET /browsers/:taskId/cdp?ticket=` (WebSocket),
   * valid for a minute. A ticket that shows up in an error message is already spent.
   */
  ticket: z.string(),
});
export type EnsureBrowserResult = z.infer<typeof EnsureBrowserResultSchema>;

/** How a stdio MCP server starts in its package's container (decision D36). Kept in the runner's memory. */
export const McpLaunchSchema = z.object({
  packageId: z.uuid(),
  /** Arguments may be empty strings; the program may not. */
  command: z
    .array(z.string().max(4096))
    .min(1)
    .max(100)
    .refine((command) => (command[0] ?? '').length > 0, 'a program to run'),
  cwd: z.string().min(1).max(4096).nullable(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(65_536)),
  /** The package's network: through the egress proxy, or none. */
  network: z.enum(['egress', 'none']),
});
export type McpLaunch = z.infer<typeof McpLaunchSchema>;

/** npm package names (scoped or not) and PyPI project names. */
export const McpPackageNameSchema = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]{0,213}$/, 'a package name');
export const McpPackageVersionSchema = z
  .string()
  .regex(/^(?:latest|[0-9A-Za-z][0-9A-Za-z.+_-]{0,63})$/, 'an exact version, or latest');

export const McpInstallInputSchema = z.object({
  servers: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        runtime: z.enum(['npm', 'uv']),
        package: McpPackageNameSchema,
        version: McpPackageVersionSchema,
        /** The executable to run from the package (npm: one of its bins; uv: a console script). */
        bin: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,128}$/)
          .optional(),
      }),
    )
    .max(20),
});
export type McpInstallInput = z.infer<typeof McpInstallInputSchema>;

export const McpInstallResultSchema = z.object({
  servers: z.array(
    z.object({
      key: z.string(),
      ok: z.boolean(),
      /** The executable to run, inside the container; null when the install failed. */
      executable: z.string().nullable(),
      /** The version installed (latest resolved). */
      version: z.string().nullable(),
      lockfile: z.string().nullable(),
      log: z.string(),
    }),
  ),
});
export type McpInstallResult = z.infer<typeof McpInstallResultSchema>;

export const RunnerMcpPackageSchema = z.object({
  packageId: z.uuid(),
  container: z.string().nullable(),
  state: z.enum(['running', 'stopped', 'absent']),
  servers: z.array(z.string()).describe('Servers whose launch the runner knows'),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type RunnerMcpPackage = z.infer<typeof RunnerMcpPackageSchema>;

/** Errors are `{ code, message }` with these codes. */
export const RunnerErrorSchema = z.object({ code: z.string(), message: z.string() });
export type RunnerErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unknown_profile'
  | 'image_missing'
  | 'sandbox_not_found'
  | 'not_found'
  | 'is_directory'
  | 'not_directory'
  | 'exists'
  | 'not_empty'
  | 'stale'
  | 'too_large'
  | 'not_regular'
  | 'fs_error'
  | 'fs_timeout'
  | 'disk_full'
  | 'sandboxes_busy'
  | 'browser_not_found'
  | 'identity_in_use'
  | 'browsers_busy'
  | 'browser_unavailable'
  | 'launch_unknown'
  | 'package_removed'
  | 'mcp_busy'
  | 'mcp_unavailable'
  | 'docker_error';
