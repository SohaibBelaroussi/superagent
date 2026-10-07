import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  EnsureSandboxResult,
  ExecResult,
  FsEntry,
  FsOperation,
  FsResult,
  FsStat,
  ProcessStatus,
  RunnerErrorCode,
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
};

const text = (buffer: Buffer) => buffer.toString('utf8');
/** What setsid --wait says about a child we killed: noise next to timedOut/killed. */
const SETSID_NOISE = /^setsid: child \d+ did not exit normally.*\n?/gm;

/**
 * One sandbox container per task (decision D10). Every command and file operation runs inside the
 * task's container, so nothing it planted (a symlink, say) is ever followed outside of it.
 */
export class SandboxManager {
  private readonly lastUsed = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
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
        if (!existing.State.Running) await this.start(name);
        this.touch(taskId);
        return { ...this.describe(await this.mustInspect(name)), outcome: 'connected' as const };
      }
      const image = this.imageFor(profile);
      await this.requireImage(image);
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
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${this.config.RUNNER_NAME_PREFIX}`] },
    });
    return containers.flatMap((container) => {
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
    return this.locked(taskId, async () => {
      try {
        await this.docker.getContainer(containerName(this.config, taskId)).remove({ force: true });
      } catch (error) {
        if (isDockerNotFound(error)) return false;
        throw error;
      }
      this.lastUsed.delete(taskId);
      this.log.info('Sandbox removed', { taskId });
      return true;
    });
  }

  /** Runs a command in the task's sandbox, or starts it in the background. */
  exec(taskId: string, input: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    return this.using(taskId, async () => {
      await this.ensure(taskId, input.profile);
      const container = this.docker.getContainer(containerName(this.config, taskId));
      const execId = randomBytes(6).toString('hex');
      const cwd = this.resolvePath(input.cwd ?? '.');
      const env = [...BASE_ENV, ...Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${value}`)];
      const started = Date.now();
      if (input.background) {
        const outcome = await execIn(this.docker, container, {
          cmd: ['sh', '-c', scripts.BACKGROUND, 'sa', execId, cwd, input.command],
          user: SANDBOX_USER,
          workingDir: WORKSPACE_DIR,
          env,
          maxOutputBytes: 64 * 1024,
        });
        return {
          execId,
          exitCode: outcome.exitCode === 0 ? null : (outcome.exitCode ?? 1),
          stdout: '',
          stderr: outcome.exitCode === 0 ? '' : text(outcome.stderr),
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          killed: false,
          durationMs: Date.now() - started,
        };
      }
      let timedOut = false;
      let killed = false;
      const stop = () => void this.killGroup(container, 'fg', execId).catch(() => {});
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, input.timeoutMs ?? this.config.RUNNER_EXEC_TIMEOUT_MS);
      const onAbort = () => {
        killed = true;
        stop();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const outcome = await execIn(this.docker, container, {
          cmd: ['sh', '-c', scripts.FOREGROUND, 'sa', execId, cwd, input.command],
          user: SANDBOX_USER,
          workingDir: WORKSPACE_DIR,
          env,
          maxOutputBytes: this.config.RUNNER_MAX_OUTPUT_BYTES,
        });
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
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        void this.run(container, ['rm', '-rf', '--', `/tmp/.sa/fg/${execId}`]).catch(() => {});
      }
    });
  }

  /** A background process's state and the end of its output. */
  async process(taskId: string, execId: string, tailBytes: number): Promise<ProcessStatus> {
    this.requireExecId(execId);
    const container = await this.runningContainer(taskId);
    const outcome = await this.run(container, [
      'sh',
      '-c',
      scripts.PROCESS_STATUS,
      'sa',
      execId,
      String(tailBytes),
    ]);
    if (outcome.exitCode === scripts.EXIT.notFound) {
      throw new RunnerError(404, 'not_found', `No process ${execId} in this sandbox`);
    }
    const [state = 'gone', command = '', outSize = '0', out = '', errSize = '0', err = ''] = text(
      outcome.stdout,
    ).split('\n');
    const stdout = Buffer.from(out, 'base64');
    const stderr = Buffer.from(err, 'base64');
    const exit = /^exit (-?\d+)$/.exec(state);
    return {
      execId,
      command: text(Buffer.from(command, 'base64')),
      running: state === 'running',
      // A process that is gone without a status was killed.
      exitCode: exit ? Number(exit[1]) : state === 'gone' ? 137 : null,
      stdout: text(stdout),
      stderr: text(stderr),
      stdoutTruncated: Number(outSize) > stdout.length,
      stderrTruncated: Number(errSize) > stderr.length,
    };
  }

  async processes(
    taskId: string,
  ): Promise<Array<Omit<ProcessStatus, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'>>> {
    const container = await this.runningContainer(taskId).catch((error: unknown) => {
      if (error instanceof RunnerError && error.code === 'sandbox_not_found') return undefined;
      throw error;
    });
    if (!container) return [];
    const outcome = await this.run(container, ['sh', '-c', scripts.PROCESS_LIST]);
    return text(outcome.stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [execId = '', state = '', command = ''] = line.split('\t');
        const exit = /^exit (-?\d+)$/.exec(state);
        return {
          execId,
          command: text(Buffer.from(command, 'base64')),
          running: state === 'running',
          exitCode: exit ? Number(exit[1]) : state === 'gone' ? 137 : null,
        };
      });
  }

  /** Stops a background process (its whole process group). False if it wasn't running. */
  async killProcess(taskId: string, execId: string): Promise<boolean> {
    this.requireExecId(execId);
    const container = await this.runningContainer(taskId);
    return this.killGroup(container, 'bg', execId);
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
        return this.fsOp(this.docker.getContainer(containerName(this.config, taskId)), request, false);
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

  /** Stops idle sandboxes and removes long-stopped ones. Their files stay. */
  async reap(now = Date.now()): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${this.config.RUNNER_NAME_PREFIX}`] },
    });
    for (const summary of containers) {
      const taskId = summary.Labels[LABELS.task];
      if (!taskId || !isTaskId(taskId)) continue;
      try {
        const container = this.docker.getContainer(summary.Id);
        if (summary.State === 'running') {
          const info = await container.inspect();
          const last = this.lastUsed.get(taskId) ?? Date.parse(info.State.StartedAt);
          if (now - last < this.config.RUNNER_IDLE_STOP_MS || (this.inFlight.get(taskId) ?? 0) > 0) continue;
          if (text((await this.run(container, ['sh', '-c', scripts.ANY_LIVE])).stdout).trim() === 'live') {
            this.touch(taskId);
            continue;
          }
          await this.locked(taskId, async () => {
            if ((this.inFlight.get(taskId) ?? 0) > 0) return;
            await container.stop({ t: 5 });
            this.log.info('Sandbox stopped (idle)', { taskId });
          });
        } else {
          const info = await container.inspect();
          const finished = Date.parse(info.State.FinishedAt);
          if (Number.isFinite(finished) && now - finished > this.config.RUNNER_REMOVE_AFTER_MS) {
            await this.remove(taskId);
          }
        }
      } catch (error) {
        this.log.warn('Reaping a sandbox failed', { taskId, error: dockerMessage(error) });
      }
    }
  }

  // --- helpers ---

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
        const entries = text(outcome.stdout)
          .split('\0')
          .filter(Boolean)
          .map((record) => this.entry(record));
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
    const [type = '', size = '0', mtime = '0'] = text(outcome.stdout).trim().split('\t');
    const mtimeMs = Math.floor(Number(mtime) * 1000);
    return {
      path: path.posix.relative(WORKSPACE_DIR, target) || '.',
      type: type === 'f' ? 'file' : type === 'd' ? 'directory' : 'other',
      size: Number(size),
      modifiedAt: new Date(mtimeMs).toISOString(),
      mtimeMs,
    };
  }

  private entry(record: string): FsEntry {
    const [type = '', size = '0', mtime = '0', target = '', ...rest] = record.split('\t');
    return {
      path: rest.join('\t'),
      type: type === 'f' ? 'file' : type === 'd' ? 'directory' : type === 'l' ? 'symlink' : 'other',
      size: Number(size),
      modifiedAt: new Date(Math.floor(Number(mtime) * 1000)).toISOString(),
      ...(type === 'l' ? { target } : {}),
    };
  }

  /** Runs a file snippet, turning its exit codes into errors. */
  private async fsRun(
    container: Docker.Container,
    script: string,
    args: string[],
    stdin?: Buffer,
    maxOutputBytes = 1024 * 1024,
  ): Promise<ExecOutcome> {
    const outcome = await this.run(container, ['sh', '-c', script, 'sa', ...args], stdin, maxOutputBytes);
    if (outcome.exitCode === 0) return outcome;
    const known = outcome.exitCode === null ? undefined : FS_EXIT[outcome.exitCode];
    if (known) throw new RunnerError(known[0], known[1], known[2]);
    throw new RunnerError(
      422,
      'fs_error',
      text(outcome.stderr).trim() || `The operation failed (exit ${outcome.exitCode})`,
    );
  }

  private run(container: Docker.Container, cmd: string[], stdin?: Buffer, maxOutputBytes = 1024 * 1024) {
    return execIn(this.docker, container, {
      cmd,
      user: SANDBOX_USER,
      workingDir: WORKSPACE_DIR,
      env: BASE_ENV,
      stdin,
      maxOutputBytes,
    });
  }

  private async killGroup(container: Docker.Container, kind: 'fg' | 'bg', execId: string): Promise<boolean> {
    const outcome = await this.run(container, ['sh', '-c', scripts.KILL, 'sa', kind, execId]);
    return outcome.exitCode === 0;
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
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(
        helperSpec(this.config, { image, cmd: ['sleep', '120'], mount: { taskId, readOnly: true } }),
      );
      await container.start();
    } catch (error) {
      // The task's folder doesn't exist: it never had a sandbox.
      this.log.debug('No workspace to read', { taskId, error: dockerMessage(error) });
      throw new RunnerError(404, 'sandbox_not_found', 'This task has no workspace');
    }
    try {
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

  private async requireImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      // Never pulled: only images built or loaded on purpose run.
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
