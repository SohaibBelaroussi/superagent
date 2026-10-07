import { StringDecoder } from 'node:string_decoder';
import {
  type CommandResult,
  type ExecuteCommandOptions,
  MastraSandbox,
  ProcessHandle,
  type ProcessInfo,
  type ProviderStatus,
  SandboxProcessManager,
  type SandboxStartResult,
  type SpawnProcessOptions,
} from '@mastra/core/workspace';
import type { ProcessStatus } from '@superagent/shared/runner';
import { MAX_FOREGROUND_MS, type RunnerClient, RunnerRequestError } from './runner-client';

/** Polling a background process backs off from this to POLL_MAX_MS. */
const POLL_START_MS = 250;
const POLL_MAX_MS = 3_000;
/** The runner bounds a background command's lifetime at this. */
const MAX_BACKGROUND_MS = 30 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strings only: Mastra's env overlay may carry unset keys. */
function cleanEnv(
  ...layers: Array<Record<string, string | undefined> | undefined>
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

const quote = (arg: string) => `'${arg.replaceAll("'", `'"'"'`)}'`;

/**
 * A background command in a task's sandbox. Its output lives in files there; this handle reads them
 * on from where it stopped, so nothing is skipped or repeated however much the command writes.
 */
class RunnerProcessHandle extends ProcessHandle {
  readonly pid: string;
  private code: number | undefined;
  private readonly offset = { out: 0, err: 0 };
  private readonly decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

  constructor(
    private readonly client: RunnerClient,
    private readonly taskId: string,
    execId: string,
    command: string,
    options?: Pick<SpawnProcessOptions, 'maxRetainedBytes' | 'onStdout' | 'onStderr'>,
  ) {
    super(options);
    this.pid = execId;
    this.command = command;
  }

  get exitCode(): number | undefined {
    return this.code;
  }

  /** Pulls the process's state and its new output. False once it is gone (its sandbox stopped). */
  async refresh(): Promise<boolean> {
    // Each answer carries at most a slice per stream: read on until caught up.
    for (let round = 0; round < 16; round++) {
      let status: ProcessStatus | undefined;
      try {
        status = await this.client.process(this.taskId, this.pid, this.offset);
      } catch (error) {
        // The runner couldn't read it this time (say, every process slot is taken): not an exit.
        if (error instanceof RunnerRequestError && error.status >= 500) return true;
        throw error;
      }
      if (!status) {
        this.code ??= 137;
        return false;
      }
      if (!this.absorb(status)) return true;
    }
    return true;
  }

  /** Takes in one slice of output; true if more is waiting. Sets the exit code once all is read. */
  absorb(status: ProcessStatus): boolean {
    const out = Buffer.from(status.stdoutBase64, 'base64');
    const err = Buffer.from(status.stderrBase64, 'base64');
    this.offset.out += out.length;
    this.offset.err += err.length;
    this.emit('out', this.decoders.out.write(out));
    this.emit('err', this.decoders.err.write(err));
    const more = this.offset.out < status.stdoutSize || this.offset.err < status.stderrSize;
    if (!status.running && !more) {
      this.emit('out', this.decoders.out.end());
      this.emit('err', this.decoders.err.end());
      this.code = status.exitCode ?? 137;
    }
    return more;
  }

  /** It never started (say, its folder doesn't exist). */
  failed(exitCode: number, stderr: string): void {
    this.emit('err', stderr);
    this.code = exitCode;
  }

  async kill(): Promise<boolean> {
    const killed = await this.client.kill(this.taskId, this.pid);
    await this.refresh().catch(() => false);
    return killed;
  }

  async sendStdin(): Promise<void> {
    throw new Error('Background commands in a task sandbox take no input');
  }

  override async wait(): Promise<CommandResult> {
    const started = Date.now();
    let delay = POLL_START_MS;
    while (this.code === undefined) {
      if (!(await this.refresh())) break;
      if (this.code === undefined) {
        await sleep(delay);
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
    }
    const exitCode = this.code ?? 137;
    return {
      success: exitCode === 0,
      exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      executionTimeMs: Date.now() - started,
      command: this.command,
    };
  }

  private emit(stream: 'out' | 'err', chunk: string): void {
    if (!chunk) return;
    if (stream === 'out') this.emitStdout(chunk);
    else this.emitStderr(chunk);
  }
}

/** Background commands, run and tracked by the runner (so they survive an API restart). */
class RunnerProcessManager extends SandboxProcessManager<RunnerSandbox> {
  constructor(
    private readonly client: RunnerClient,
    private readonly taskId: string,
    private readonly profile: string,
  ) {
    super();
  }

  override async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    const result = await this.client.exec(
      this.taskId,
      {
        profile: this.profile,
        command,
        cwd: options.cwd,
        env: cleanEnv(this.sandbox?.getEnv(), options.env),
        background: true,
        ...(options.timeout
          ? { timeoutMs: Math.min(Math.max(options.timeout, 1000), MAX_BACKGROUND_MS) }
          : {}),
      },
      options.abortSignal,
    );
    const handle = new RunnerProcessHandle(this.client, this.taskId, result.execId, command, options);
    if (result.exitCode !== null) handle.failed(result.exitCode, result.stderr);
    this._tracked.set(handle.pid, handle);
    return handle;
  }

  override async list(): Promise<ProcessInfo[]> {
    return (await this.client.processes(this.taskId)).map((process) => ({
      pid: process.execId,
      command: process.command,
      running: process.running,
      ...(process.exitCode === null ? {} : { exitCode: process.exitCode }),
    }));
  }

  /** Found here, or (after an API restart) in the sandbox itself. */
  override async get(pid: string): Promise<ProcessHandle | undefined> {
    const tracked = this._tracked.get(pid) as RunnerProcessHandle | undefined;
    if (tracked) {
      await tracked.refresh();
      return tracked;
    }
    if (this._dismissed.has(pid) || !/^[a-f0-9]{12}$/.test(pid)) return undefined;
    const info = (await this.client.processes(this.taskId)).find((process) => process.execId === pid);
    if (!info) return undefined;
    const handle = new RunnerProcessHandle(this.client, this.taskId, pid, info.command);
    if (!(await handle.refresh())) return undefined;
    this._tracked.set(pid, handle);
    return handle;
  }
}

/**
 * A task's sandbox, run by the runner (decisions D10, D33): a container that sees only the task's
 * folder, at /workspace, with no network. Stopping is the runner's reaper's job: an idle sandbox is
 * stopped and comes back, files intact, on the next command.
 */
export class RunnerSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = 'Task sandbox';
  readonly provider = 'superagent-runner';
  status: ProviderStatus = 'pending';
  declare readonly processes: RunnerProcessManager;

  constructor(
    private readonly client: RunnerClient,
    readonly taskId: string,
    private readonly profile: string,
  ) {
    super({
      name: 'Task sandbox',
      processes: new RunnerProcessManager(client, taskId, profile),
      workingDirectory: '/workspace',
    });
    this.id = `task-${taskId}`;
  }

  override async start(): Promise<SandboxStartResult> {
    const result = await this.client.ensure(this.taskId, this.profile);
    return { outcome: result.outcome };
  }

  override async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    await this.ensureRunning();
    const full = args.length > 0 ? [command, ...args.map(quote)].join(' ') : command;
    // Long jobs belong in the background (execute_command's background option).
    const timeoutMs = Math.min(options.timeout ?? 120_000, MAX_FOREGROUND_MS);
    const result = await this.client.exec(
      this.taskId,
      {
        profile: this.profile,
        command: full,
        cwd: options.cwd,
        env: cleanEnv(this.getEnv(), options.env),
        timeoutMs: Math.max(timeoutMs, 100),
      },
      options.abortSignal,
    );
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);
    const exitCode = result.exitCode ?? (result.timedOut || result.killed ? 124 : -1);
    return {
      success: exitCode === 0 && !result.timedOut,
      exitCode,
      stdout: result.stdout,
      stderr: result.timedOut ? `${result.stderr}\n(timed out after ${timeoutMs} ms)`.trim() : result.stderr,
      executionTimeMs: result.durationMs,
      timedOut: result.timedOut,
      killed: result.killed,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      command: full,
    };
  }

  override getInstructions(): string {
    return [
      "Commands run in this task's sandbox: a Linux container (Debian) with Node.js, Python 3 and git.",
      'Your files are in /workspace (the working directory), kept between commands and turns. Only /workspace and /tmp are writable; /tmp is wiped when the sandbox stops.',
      'There is no network access: nothing can be downloaded or installed (no pip or npm install). Use what is installed.',
      'For anything that takes more than a few minutes, run it in the background and check its output.',
    ].join('\n');
  }

  /** The runner's reaper stops idle sandboxes; an agent never needs to. */
  override async stop(): Promise<void> {}

  override async destroy(): Promise<void> {}
}
