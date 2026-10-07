import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  EnsureSandboxResult,
  ExecResult,
  FsEntry,
  FsOperation,
  FsResult,
  FsStat,
  ProcessInfo,
  ProcessStatus,
  RunnerErrorCode,
  RunnerReady,
  RunnerSandbox,
} from '@superagent/shared/runner';
import type Docker from 'dockerode';
import type { RunnerConfig } from './config';
import { dockerMessage, type ExecOutcome, execIn, isDockerNotFound } from './docker';
import {
  containerName,
  helperSpec,
  isTaskId,
  LABELS,
  SANDBOX_USER,
  sandboxSpec,
  WORKSPACE_DIR,
} from './policy';
import * as scripts from './scripts';

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** The sandbox couldn't start a process: restart it (its files stay) and try again. */
class NoRoomError extends RunnerError {
  constructor() {
    super(503, 'docker_error', 'The sandbox could not start a process');
  }
}

function couldNotStart(outcome: ExecOutcome): boolean {
  return outcome.exitCode !== 0 && EXEC_FAILED.test(`${text(outcome.stdout)}${text(outcome.stderr)}`);
}

export interface ExecRequest {
  profile: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
}

const EXEC_ID = /^[a-f0-9]{12}$/;
const WRITE_OPS = new Set(['write', 'mkdir', 'remove', 'copy', 'move']);
const BASE_ENV = [
  'HOME=/tmp',
  'LANG=C.UTF-8',
  'PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
];
const FS_EXIT: Record<number, [number, RunnerErrorCode, string]> = {
  [scripts.EXIT.notFound]: [404, 'not_found', 'No such file or folder'],
  [scripts.EXIT.isDirectory]: [409, 'is_directory', 'That is a folder'],
  [scripts.EXIT.notDirectory]: [409, 'not_directory', 'Not a folder'],
  [scripts.EXIT.exists]: [409, 'exists', 'It exists already'],
  [scripts.EXIT.notEmpty]: [409, 'not_empty', 'The folder is not empty'],
  [scripts.EXIT.notRegular]: [409, 'not_regular', 'Not a regular file (a pipe, socket or device)'],
};
/** `timeout -s KILL` ends a file snippet that ran too long with 137. */
const KILLED_BY_TIMEOUT = 137;
/** How long a foreground command may outlive its timeout before the container itself is killed. */
const KILL_GRACE_MS = 15_000;
/** Helpers (readers, folder makers) older than this are leftovers. */
const HELPER_MAX_AGE_MS = 10 * 60_000;
/** Free space is checked at most this often per sandbox. */
const DISK_CHECK_MS = 10_000;
/** The most a process status returns per stream; callers read on from the offset. */
export const MAX_PROCESS_SLICE = 1024 * 1024;

const text = (buffer: Buffer) => buffer.toString('utf8');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What setsid --wait says about a child we killed: noise next to timedOut/killed. */
const SETSID_NOISE = /^setsid: child \d+ did not exit normally.*\n?/gm;
/** docker exec couldn't start a process at all: every slot is taken (or the runtime failed). */
const EXEC_FAILED = /OCI runtime exec failed|unable to start container process/;
/** Docker refuses a volume subpath that isn't there: the task never had a workspace. */
const MISSING_SUBPATH = /no such file or directory|cannot access path|not a directory/i;

/**
 * One sandbox container per task (decision D10). Every command and file operation runs inside the
 * task's container, so nothing it planted (a symlink, say) is ever followed outside of it.
 */
export class SandboxManager {
  private readonly lastUsed = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly diskChecks = new Map<string, number>();
  private volumeReady: Promise<void> | undefined;

  constructor(
    private readonly docker: Docker,
    private readonly config: RunnerConfig,
    private readonly log: Logger,
  ) {}

  /** Gets the task's sandbox running: its existing container (started if stopped) or a new one. */
  ensure(taskId: string, profile: string): Promise<EnsureSandboxResult> {
    this.requireTaskId(taskId);
    return this.locked(taskId, async () => {
      const name = containerName(this.config, taskId);
      const existing = await this.inspect(name);
      if (existing) {
        if (!existing.State.Running) {
          await this.makeRoom(taskId);
          await this.start(name);
        }
        this.touch(taskId);
        return { ...this.describe(await this.mustInspect(name)), outcome: 'connected' as const };
      }
      const image = this.imageFor(profile);
      await this.requireImage(image);
      await this.makeRoom(taskId);
      await this.prepareVolume(image);
      await this.runHelper(
        helperSpec(this.config, {
          image,
          cmd: ['mkdir', '-p', `/w/tasks/${taskId}`],
          mount: { readOnly: false },
        }),
      );
      const container = await this.docker.createContainer(
        sandboxSpec(this.config, { taskId, profile, image }),
      );
      await container.start();
      this.touch(taskId);
      this.log.info('Sandbox created', { taskId, profile, image });
      return { ...this.describe(await container.inspect()), outcome: 'created' as const };
    });
  }

  async list(): Promise<RunnerSandbox[]> {
    return (await this.sandboxContainers()).flatMap((container) => {
      const taskId = container.Labels[LABELS.task];
      if (!taskId) return [];
      const used = this.lastUsed.get(taskId);
      return [
        {
          taskId,
          container: (container.Names[0] ?? '').replace(/^\//, ''),
          profile: container.Labels[LABELS.profile] ?? 'unknown',
          image: container.Image,
          state: container.State === 'running' ? ('running' as const) : ('stopped' as const),
          createdAt: new Date(container.Created * 1000).toISOString(),
          lastUsedAt: used ? new Date(used).toISOString() : null,
        },
      ];
    });
  }

  async get(taskId: string): Promise<RunnerSandbox | undefined> {
    this.requireTaskId(taskId);
    const info = await this.inspect(containerName(this.config, taskId));
    return info ? this.describe(info) : undefined;
  }

  /** Removes the task's container; its files stay in the workspaces volume. */
  remove(taskId: string): Promise<boolean> {
    this.requireTaskId(taskId);
    return this.locked(taskId, () => this.removeNow(taskId));
  }

  /** Whether Docker answers and which profiles' images are built (for the API's health checks). */
  async ready(): Promise<Omit<RunnerReady, 'browser'>> {
    let docker = true;
    try {
      await this.docker.ping();
    } catch {
      docker = false;
    }
    const images: Record<string, boolean> = {};
    for (const [profile, image] of Object.entries(this.config.RUNNER_IMAGES)) {
      images[profile] = docker && (await this.hasImage(image));
    }
    return { docker, images };
  }

  /** Runs a command in the task's sandbox, or starts it in the background. */
  exec(taskId: string, input: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    return this.using(taskId, async () => {
      const started = Date.now();
      const nothing = (killed: boolean, stderr = ''): ExecResult => ({
        execId: '000000000000',
        exitCode: null,
        stdout: '',
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        killed,
        durationMs: Date.now() - started,
      });
      await this.ensure(taskId, input.profile);
      // Cancelled while the sandbox was being created: don't run it at all.
      if (signal?.aborted) return nothing(true);
      const container = this.docker.getContainer(containerName(this.config, taskId));
      await this.requireDiskSpace(taskId, container);
      const execId = randomBytes(6).toString('hex');
      const cwd = this.resolvePath(input.cwd ?? '.');
      const env = [...BASE_ENV, ...Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${value}`)];
      if (input.background) {
        const seconds = input.timeoutMs ? String(Math.ceil(input.timeoutMs / 1000)) : '';
        const outcome = await this.withRoom(taskId, input.profile, container, () =>
          execIn(this.docker, container, {
            cmd: ['sh', '-c', scripts.BACKGROUND, 'sa', execId, cwd, input.command, seconds],
            user: SANDBOX_USER,
            workingDir: WORKSPACE_DIR,
            env,
            maxOutputBytes: 64 * 1024,
            deadlineMs: 30_000,
          }),
        );
        if (outcome.abandoned) {
          throw new RunnerError(503, 'docker_error', 'The sandbox did not start the command in time');
        }
        return {
          ...nothing(false, outcome.exitCode === 0 ? '' : text(outcome.stderr)),
          execId,
          exitCode: outcome.exitCode === 0 ? null : (outcome.exitCode ?? 1),
        };
      }
      const timeoutMs = input.timeoutMs ?? this.config.RUNNER_EXEC_TIMEOUT_MS;
      let timedOut = false;
      let killed = false;
      let finished = false;
      const stop = () => void this.stopCommand(taskId, container, execId, () => finished);
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = () => {
        killed = true;
        stop();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const outcome = await this.withRoom(taskId, input.profile, container, () =>
          execIn(this.docker, container, {
            cmd: ['sh', '-c', scripts.FOREGROUND, 'sa', execId, cwd, input.command],
            user: SANDBOX_USER,
            workingDir: WORKSPACE_DIR,
            env,
            maxOutputBytes: this.config.RUNNER_MAX_OUTPUT_BYTES,
            deadlineMs: timeoutMs + KILL_GRACE_MS,
          }),
        );
        if (outcome.abandoned) {
          // Nothing could kill it: everything in the sandbox goes, files stay.
          timedOut = true;
          await this.killContainer(taskId, container);
        }
        return {
          execId,
          exitCode: outcome.exitCode,
          stdout: text(outcome.stdout),
          stderr: timedOut || killed ? text(outcome.stderr).replace(SETSID_NOISE, '') : text(outcome.stderr),
          stdoutTruncated: outcome.stdoutTruncated,
          stderrTruncated: outcome.stderrTruncated,
          timedOut,
          killed,
          durationMs: Date.now() - started,
        };
      } finally {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        void this.run(container, ['rm', '-rf', '--', `/tmp/.sa/fg/${execId}`]).catch(() => {});
      }
    });
  }

  /**
   * A background process's state and the next slice of its output: bytes from `from.out` and
   * `from.err`, at most `maxBytes` each.
   */
  async process(
    taskId: string,
    execId: string,
    from: { out: number; err: number },
    maxBytes: number,
  ): Promise<ProcessStatus> {
    this.requireExecId(execId);
    const container = await this.runningContainer(taskId);
    const slice = Math.min(Math.max(maxBytes, 1), MAX_PROCESS_SLICE);
    const outcome = await this.run(
      container,
      ['sh', '-c', scripts.PROCESS_STATUS, 'sa', execId, String(from.out), String(from.err), String(slice)],
      undefined,
      // Two base64 slices and a few short lines.
      2 * Math.ceil(slice / 3) * 4 + 64 * 1024,
    );
    if (outcome.exitCode === scripts.EXIT.notFound) {
      throw new RunnerError(404, 'not_found', `No process ${execId} in this sandbox`);
    }
    if (outcome.exitCode !== 0 || outcome.stdoutTruncated) {
      throw new RunnerError(503, 'docker_error', 'The process status could not be read; try again');
    }
    const [state = 'gone', command = '', outSize = '0', out = '', errSize = '0', err = ''] = text(
      outcome.stdout,
    ).split('\n');
    return {
      ...this.info(execId, state, command),
      stdoutSize: Number(outSize) || 0,
      stderrSize: Number(errSize) || 0,
      stdoutBase64: out,
      stderrBase64: err,
    };
  }

  async processes(taskId: string): Promise<ProcessInfo[]> {
    const container = await this.runningContainer(taskId).catch((error: unknown) => {
      if (error instanceof RunnerError && error.code === 'sandbox_not_found') return undefined;
      throw error;
    });
    if (!container) return [];
    const outcome = await this.run(container, ['sh', '-c', scripts.PROCESS_LIST]);
    if (outcome.exitCode !== 0) {
      throw new RunnerError(503, 'docker_error', 'The processes could not be listed; try again');
    }
    return text(outcome.stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [execId = '', state = '', command = ''] = line.split('\t');
        return this.info(execId, state, command);
      });
  }

  /** Stops a background process (its whole process group). False if it wasn't running. */
  async killProcess(taskId: string, execId: string): Promise<boolean> {
    this.requireExecId(execId);
    const container = await this.runningContainer(taskId);
    const outcome = await this.run(container, ['sh', '-c', scripts.KILL, 'sa', 'bg', execId]);
    if (outcome.exitCode === 0) return true;
    if (outcome.exitCode === 3) return false;
    throw new RunnerError(503, 'docker_error', 'The process could not be stopped; try again');
  }

  /**
   * A file operation, run inside the task's sandbox. `peek` (for the owner's file routes) never
   * creates a sandbox: without one, a throwaway container mounts the task's folder read-only.
   */
  fs(taskId: string, request: FsOperation, options: { profile: string; peek?: boolean }): Promise<FsResult> {
    this.requireTaskId(taskId);
    if (options.peek && WRITE_OPS.has(request.op)) {
      throw new RunnerError(400, 'invalid_request', 'Peeking only reads');
    }
    return this.using(taskId, async () => {
      if (!options.peek) {
        await this.ensure(taskId, options.profile);
        const container = this.docker.getContainer(containerName(this.config, taskId));
        if (WRITE_OPS.has(request.op)) await this.requireDiskSpace(taskId, container);
        try {
          return await this.fsOp(container, request, false);
        } catch (error) {
          if (!(error instanceof NoRoomError)) throw error;
          await this.killContainer(taskId, container);
          await this.ensure(taskId, options.profile);
          return this.fsOp(container, request, false);
        }
      }
      const name = containerName(this.config, taskId);
      const existing = await this.inspect(name);
      if (existing) {
        if (!existing.State.Running) await this.locked(taskId, () => this.start(name));
        return this.fsOp(this.docker.getContainer(name), request, true);
      }
      return this.withReader(taskId, options.profile, (container) => this.fsOp(container, request, true));
    });
  }

  /** Stops idle sandboxes, removes long-stopped ones and sweeps leftover helpers. Files stay. */
  async reap(now = Date.now()): Promise<void> {
    for (const summary of await this.sandboxContainers()) {
      const taskId = summary.Labels[LABELS.task];
      if (!taskId || !isTaskId(taskId)) continue;
      try {
        const container = this.docker.getContainer(summary.Id);
        if (summary.State === 'running') {
          const info = await container.inspect();
          const last = this.lastUsed.get(taskId) ?? Date.parse(info.State.StartedAt);
          if (now - last < this.config.RUNNER_IDLE_STOP_MS || this.busy(taskId)) continue;
          if (await this.hasLiveProcess(container)) {
            this.touch(taskId);
            continue;
          }
          await this.locked(taskId, async () => {
            if (this.busy(taskId)) return;
            await container.stop({ t: 5 });
            this.log.info('Sandbox stopped (idle)', { taskId });
          });
        } else {
          // Decided under the lock: a command may be bringing it back right now.
          await this.locked(taskId, async () => {
            const info = await container.inspect();
            if (info.State.Running || this.busy(taskId)) return;
            const finished = Date.parse(info.State.FinishedAt);
            // A container that never ran reports year 1: count from its creation instead.
            const since = Number.isFinite(finished) && finished > 0 ? finished : Date.parse(info.Created);
            if (now - since > this.config.RUNNER_REMOVE_AFTER_MS) await this.removeNow(taskId);
          });
        }
      } catch (error) {
        this.log.warn('Reaping a sandbox failed', { taskId, error: dockerMessage(error) });
      }
    }
    await this.sweepHelpers(now);
  }

  // --- helpers ---

  private info(execId: string, state: string, command: string): ProcessInfo {
    const exit = /^exit (-?\d+)$/.exec(state);
    return {
      execId,
      command: text(Buffer.from(command, 'base64')),
      running: state === 'running',
      // A process that is gone without a status was killed.
      exitCode: exit ? Number(exit[1]) : state === 'gone' ? 137 : null,
    };
  }

  private async fsOp(
    container: Docker.Container,
    request: FsOperation,
    confined: boolean,
  ): Promise<FsResult> {
    const target = this.resolvePath(request.path, confined);
    switch (request.op) {
      case 'read': {
        const max = request.maxBytes ?? 10 * 1024 * 1024;
        const outcome = await this.fsRun(
          container,
          scripts.READ,
          [target, String(max + 1)],
          undefined,
          max + 1,
        );
        const content = outcome.stdout.subarray(0, max);
        return {
          contentBase64: content.toString('base64'),
          size: Number.parseInt(text(outcome.stderr), 10) || outcome.stdout.length,
          truncated: outcome.stdout.length > max,
        };
      }
      case 'write': {
        const expected = request.expectedMtimeMs;
        if (expected !== undefined) {
          const current = await this.stat(container, target).catch((error: unknown) => {
            if (error instanceof RunnerError && error.code === 'not_found') return undefined;
            throw error;
          });
          if (current && Math.abs(current.mtimeMs - expected) >= 1) {
            throw new RunnerError(409, 'stale', `${request.path} changed since it was read`);
          }
        }
        const content = Buffer.from(request.contentBase64, 'base64');
        await this.fsRun(container, scripts.WRITE, [target, request.mode], content);
        const stat = await this.stat(container, target);
        return { size: stat.size, stat };
      }
      case 'list': {
        const limit = request.limit;
        const outcome = await this.fsRun(
          container,
          scripts.LIST,
          [target, String(request.maxDepth), String(limit + 1)],
          undefined,
          16 * 1024 * 1024,
        );
        const fields = outcome.stdout.toString('utf8').split('\0');
        const entries: FsEntry[] = [];
        for (let i = 0; i + 4 < fields.length; i += 5) {
          entries.push(this.entry(fields.slice(i, i + 5)));
        }
        return { entries: entries.slice(0, limit), truncated: entries.length > limit };
      }
      case 'stat':
        return { stat: await this.stat(container, target) };
      case 'mkdir':
        await this.fsRun(container, scripts.MKDIR, [target, request.recursive ? '1' : '0']);
        return {};
      case 'remove':
        await this.fsRun(container, scripts.REMOVE, [
          target,
          request.kind,
          request.recursive ? '1' : '0',
          request.force ? '1' : '0',
        ]);
        return {};
      case 'copy':
      case 'move':
        await this.fsRun(container, scripts.COPY, [
          target,
          this.resolvePath(request.dest, confined),
          request.overwrite ? '1' : '0',
          request.op,
        ]);
        return {};
    }
  }

  private async stat(container: Docker.Container, target: string): Promise<FsStat> {
    const outcome = await this.fsRun(container, scripts.STAT, [target]);
    const [type = '', size = '0', mtime = '0', binary = '0'] = text(outcome.stdout).trim().split('\t');
    const mtimeMs = Math.floor(Number(mtime) * 1000);
    return {
      path: path.posix.relative(WORKSPACE_DIR, target) || '.',
      type: type === 'f' ? 'file' : type === 'd' ? 'directory' : 'other',
      size: Number(size),
      modifiedAt: new Date(mtimeMs).toISOString(),
      mtimeMs,
      binary: binary === '1',
    };
  }

  private entry([type = '', size = '0', mtime = '0', target = '', relative = '']: string[]): FsEntry {
    return {
      path: relative,
      type: type === 'f' ? 'file' : type === 'd' ? 'directory' : type === 'l' ? 'symlink' : 'other',
      size: Number(size),
      modifiedAt: new Date(Math.floor(Number(mtime) * 1000)).toISOString(),
      ...(type === 'l' ? { target } : {}),
    };
  }

  /** Runs a file snippet under a time limit, turning its exit codes into errors. */
  private async fsRun(
    container: Docker.Container,
    script: string,
    args: string[],
    stdin?: Buffer,
    maxOutputBytes = 1024 * 1024,
  ): Promise<ExecOutcome> {
    const seconds = String(Math.ceil(this.config.RUNNER_FS_TIMEOUT_MS / 1000));
    const outcome = await this.run(
      container,
      ['timeout', '-s', 'KILL', seconds, 'sh', '-c', script, 'sa', ...args],
      stdin,
      maxOutputBytes,
      this.config.RUNNER_FS_TIMEOUT_MS + 10_000,
    );
    if (outcome.abandoned || outcome.exitCode === KILLED_BY_TIMEOUT) {
      throw new RunnerError(504, 'fs_timeout', 'The file operation took too long');
    }
    if (outcome.exitCode === 0) return outcome;
    if (couldNotStart(outcome)) throw new NoRoomError();
    const known = outcome.exitCode === null ? undefined : FS_EXIT[outcome.exitCode];
    if (known) throw new RunnerError(known[0], known[1], known[2]);
    throw new RunnerError(
      422,
      'fs_error',
      text(outcome.stderr).trim() || `The operation failed (exit ${outcome.exitCode})`,
    );
  }

  private run(
    container: Docker.Container,
    cmd: string[],
    stdin?: Buffer,
    maxOutputBytes = 1024 * 1024,
    deadlineMs = 30_000,
  ) {
    return execIn(this.docker, container, {
      cmd,
      user: SANDBOX_USER,
      workingDir: WORKSPACE_DIR,
      env: BASE_ENV,
      stdin,
      maxOutputBytes,
      deadlineMs,
    });
  }

  /**
   * Stops a foreground command: its process group, retried until the pid file exists or the command
   * ends; if no kill gets through (say, every process slot is taken), the container itself.
   */
  private async stopCommand(
    taskId: string,
    container: Docker.Container,
    execId: string,
    finished: () => boolean,
  ): Promise<void> {
    const until = Date.now() + 5_000;
    while (!finished() && Date.now() < until) {
      const outcome = await this.run(
        container,
        ['sh', '-c', scripts.KILL, 'sa', 'fg', execId],
        undefined,
        4096,
        5_000,
      )
        .then((o) => o.exitCode)
        .catch(() => null);
      if (outcome === 0) return;
      await sleep(200);
    }
    if (!finished()) await this.killContainer(taskId, container);
  }

  /**
   * Runs an exec; if the sandbox has no room to start it (its processes take every slot, even after
   * a kill, until they are reaped), restarts the sandbox (files stay) and runs it once more.
   */
  private async withRoom(
    taskId: string,
    profile: string,
    container: Docker.Container,
    exec: () => Promise<ExecOutcome>,
  ): Promise<ExecOutcome> {
    const outcome = await exec();
    if (!couldNotStart(outcome)) return outcome;
    await this.killContainer(taskId, container);
    await this.ensure(taskId, profile);
    return exec();
  }

  private async killContainer(taskId: string, container: Docker.Container): Promise<void> {
    try {
      await container.kill();
      this.log.warn('Sandbox killed: a command could not be stopped', { taskId });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) {
        this.log.error('Killing a sandbox failed', { taskId, error: dockerMessage(error) });
      }
    }
  }

  private async hasLiveProcess(container: Docker.Container): Promise<boolean> {
    const outcome = await this.run(container, ['sh', '-c', scripts.ANY_LIVE], undefined, 4096, 10_000);
    // Can't tell (say, no process slot free): treat it as busy rather than stop it under a command.
    return outcome.exitCode !== 0 || text(outcome.stdout).trim() === 'live';
  }

  /** Refuses work while the workspaces' disk is nearly full (checked every few seconds per sandbox). */
  private async requireDiskSpace(taskId: string, container: Docker.Container): Promise<void> {
    if (this.config.RUNNER_MIN_FREE_MB <= 0) return;
    const last = this.diskChecks.get(taskId);
    if (last && Date.now() - last < DISK_CHECK_MS) return;
    const outcome = await this.run(container, ['sh', '-c', scripts.FREE_SPACE], undefined, 4096, 10_000);
    const availableKb = Number(text(outcome.stdout).trim().split(/\s+/)[3]);
    if (Number.isFinite(availableKb) && availableKb < this.config.RUNNER_MIN_FREE_MB * 1024) {
      this.diskChecks.delete(taskId);
      throw new RunnerError(
        507,
        'disk_full',
        `The workspaces disk is nearly full (${Math.floor(availableKb / 1024)} MiB free): delete files before running more`,
      );
    }
    this.diskChecks.set(taskId, Date.now());
  }

  /** At the running limit, stops the least recently used idle sandbox, or refuses. */
  private async makeRoom(taskId: string): Promise<void> {
    const running = (await this.sandboxContainers()).filter(
      (c) => c.State === 'running' && c.Labels[LABELS.task] !== taskId,
    );
    if (running.length < this.config.RUNNER_MAX_RUNNING) return;
    const candidates = running
      .map((c) => ({ container: c, taskId: c.Labels[LABELS.task] ?? '' }))
      .filter((c) => isTaskId(c.taskId) && !this.busy(c.taskId))
      .sort((a, b) => (this.lastUsed.get(a.taskId) ?? 0) - (this.lastUsed.get(b.taskId) ?? 0));
    for (const candidate of candidates) {
      const container = this.docker.getContainer(candidate.container.Id);
      // Under its own lock: a command may be about to use it.
      const stopped = await this.locked(candidate.taskId, async () => {
        if (this.busy(candidate.taskId) || (await this.hasLiveProcess(container).catch(() => true)))
          return false;
        await container.stop({ t: 5 });
        return true;
      });
      if (!stopped) continue;
      this.log.info('Sandbox stopped to make room', { taskId: candidate.taskId, for: taskId });
      return;
    }
    throw new RunnerError(
      503,
      'sandboxes_busy',
      `${running.length} sandboxes are busy (the limit is ${this.config.RUNNER_MAX_RUNNING}); try again later`,
    );
  }

  /** Paths are relative to /workspace. Confined paths (the owner's file routes) may not leave it. */
  private resolvePath(input: string, confined = false): string {
    const resolved = path.posix.resolve(WORKSPACE_DIR, input);
    if (confined && resolved !== WORKSPACE_DIR && !resolved.startsWith(`${WORKSPACE_DIR}/`)) {
      throw new RunnerError(400, 'invalid_request', 'Paths stay inside the workspace');
    }
    return resolved;
  }

  /** A throwaway container with the task's folder mounted read-only, for reading without a sandbox. */
  private async withReader<T>(
    taskId: string,
    profile: string,
    fn: (container: Docker.Container) => Promise<T>,
  ): Promise<T> {
    const image = this.imageFor(profile);
    await this.requireImage(image);
    const container = await this.docker.createContainer(
      helperSpec(this.config, { image, cmd: ['sleep', '120'], mount: { taskId, readOnly: true } }),
    );
    try {
      try {
        await container.start();
      } catch (error) {
        if (MISSING_SUBPATH.test(dockerMessage(error))) {
          // The task's folder doesn't exist: no agent ever worked in it.
          throw new RunnerError(404, 'sandbox_not_found', 'This task has no workspace');
        }
        throw error;
      }
      return await fn(container);
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  /** The volume with the tasks folder, owned by the sandbox user. Once per runner. */
  private prepareVolume(image: string): Promise<void> {
    this.volumeReady ??= (async () => {
      await this.docker.createVolume({
        Name: this.config.RUNNER_WORKSPACES_VOLUME,
        Labels: { [LABELS.runner]: this.config.RUNNER_NAME_PREFIX },
      });
      await this.runHelper(
        helperSpec(this.config, {
          image,
          cmd: ['sh', '-c', 'mkdir -p /w/tasks && chown 1000:1000 /w/tasks'],
          mount: { readOnly: false },
          asRoot: true,
        }),
      );
    })().catch((error: unknown) => {
      this.volumeReady = undefined;
      throw error;
    });
    return this.volumeReady;
  }

  private async runHelper(spec: Docker.ContainerCreateOptions): Promise<void> {
    const container = await this.docker.createContainer(spec);
    try {
      await container.start();
      const result = (await container.wait()) as { StatusCode: number };
      if (result.StatusCode !== 0) {
        const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
        throw new RunnerError(
          500,
          'docker_error',
          `Preparing the workspace failed: ${logs.toString('utf8').trim()}`,
        );
      }
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  /** Removes helpers a crash or an error left behind. */
  private async sweepHelpers(now: number): Promise<void> {
    const helpers = await this.docker
      .listContainers({
        all: true,
        filters: { label: [`${LABELS.runner}=${this.config.RUNNER_NAME_PREFIX}-helper`] },
      })
      .catch(() => []);
    for (const helper of helpers) {
      if (now - helper.Created * 1000 < HELPER_MAX_AGE_MS) continue;
      await this.docker
        .getContainer(helper.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }

  private sandboxContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${this.config.RUNNER_NAME_PREFIX}`] },
    });
  }

  private async removeNow(taskId: string): Promise<boolean> {
    try {
      await this.docker.getContainer(containerName(this.config, taskId)).remove({ force: true });
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
    this.lastUsed.delete(taskId);
    this.diskChecks.delete(taskId);
    this.log.info('Sandbox removed', { taskId });
    return true;
  }

  private async runningContainer(taskId: string): Promise<Docker.Container> {
    this.requireTaskId(taskId);
    const name = containerName(this.config, taskId);
    const info = await this.inspect(name);
    if (!info?.State.Running) {
      throw new RunnerError(
        404,
        'sandbox_not_found',
        'The sandbox is not running (its processes ended with it)',
      );
    }
    this.touch(taskId);
    return this.docker.getContainer(name);
  }

  private imageFor(profile: string): string {
    const image = this.config.RUNNER_IMAGES[profile];
    if (!image) throw new RunnerError(400, 'unknown_profile', `No sandbox profile "${profile}"`);
    return image;
  }

  private async hasImage(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  private async requireImage(image: string): Promise<void> {
    // Never pulled: only images built or loaded on purpose run.
    if (!(await this.hasImage(image))) {
      throw new RunnerError(503, 'image_missing', `The sandbox image ${image} is not built on this host`);
    }
  }

  private async start(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).start();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 304) throw error; // already running
    }
  }

  private async inspect(name: string): Promise<Docker.ContainerInspectInfo | undefined> {
    try {
      return await this.docker.getContainer(name).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) return undefined;
      throw error;
    }
  }

  private async mustInspect(name: string): Promise<Docker.ContainerInspectInfo> {
    const info = await this.inspect(name);
    if (!info) throw new RunnerError(404, 'sandbox_not_found', 'The sandbox disappeared');
    return info;
  }

  private describe(info: Docker.ContainerInspectInfo): RunnerSandbox {
    const taskId = info.Config.Labels[LABELS.task] ?? '';
    const used = this.lastUsed.get(taskId);
    return {
      taskId,
      container: info.Name.replace(/^\//, ''),
      profile: info.Config.Labels[LABELS.profile] ?? 'unknown',
      image: info.Config.Image,
      state: info.State.Running ? 'running' : 'stopped',
      createdAt: new Date(info.Created).toISOString(),
      lastUsedAt: used ? new Date(used).toISOString() : null,
    };
  }

  private touch(taskId: string): void {
    this.lastUsed.set(taskId, Date.now());
  }

  private busy(taskId: string): boolean {
    return (this.inFlight.get(taskId) ?? 0) > 0;
  }

  /** Marks the task busy while `fn` runs, so the reaper leaves its sandbox alone. */
  private async using<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    this.requireTaskId(taskId);
    this.inFlight.set(taskId, (this.inFlight.get(taskId) ?? 0) + 1);
    this.touch(taskId);
    try {
      return await fn();
    } finally {
      const left = (this.inFlight.get(taskId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(taskId, left);
      else this.inFlight.delete(taskId);
      this.touch(taskId);
    }
  }

  /** Runs one lifecycle change of a task's sandbox at a time. */
  private locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(taskId, settled);
    void settled.then(() => {
      if (this.locks.get(taskId) === settled) this.locks.delete(taskId);
    });
    return next;
  }

  private requireTaskId(taskId: string): void {
    if (!isTaskId(taskId)) throw new RunnerError(400, 'invalid_request', 'Not a task id');
  }

  private requireExecId(execId: string): void {
    if (!EXEC_ID.test(execId)) throw new RunnerError(400, 'invalid_request', 'Not a process id');
  }
}
