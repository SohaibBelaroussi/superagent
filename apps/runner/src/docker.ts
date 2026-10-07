import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps the last `max` bytes written to it, like a terminal's scrollback. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 0) {
      const first = this.chunks[0] as Buffer;
      const excess = this.size - this.max;
      this.truncated = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  value(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ExecSpec {
  cmd: string[];
  user?: string;
  workingDir?: string;
  env?: string[];
  /** Written to the command's stdin, which is then closed. */
  stdin?: Buffer;
  maxOutputBytes: number;
}

export interface ExecOutcome {
  /** null if Docker didn't report one (the exec was still running when its stream closed). */
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Runs a command in a running container and waits for it, keeping the end of its output. */
export async function execIn(
  docker: Docker,
  container: Docker.Container,
  spec: ExecSpec,
): Promise<ExecOutcome> {
  const exec = await container.exec({
    Cmd: spec.cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: spec.stdin !== undefined,
    User: spec.user,
    WorkingDir: spec.workingDir,
    Env: spec.env,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: spec.stdin !== undefined });
  const stdout = new TailBuffer(spec.maxOutputBytes);
  const stderr = new TailBuffer(spec.maxOutputBytes);
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk: Buffer) => stdout.push(chunk));
  err.on('data', (chunk: Buffer) => stderr.push(chunk));
  docker.modem.demuxStream(stream, out, err);
  const ended = new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', reject);
  });
  if (spec.stdin !== undefined) {
    stream.write(spec.stdin);
    // Half-closes the connection: the command sees end of input and goes on.
    stream.end();
  }
  await ended;
  // With stdin attached, the stream can close before the process has exited.
  let info = await exec.inspect();
  for (let i = 0; info.Running && i < 500; i++) {
    await sleep(20);
    info = await exec.inspect();
  }
  return {
    exitCode: info.Running ? null : (info.ExitCode ?? null),
    stdout: stdout.value(),
    stderr: stderr.value(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

/** Splits a non-TTY container log (Docker's multiplexed frames) into stdout and stderr. */
export function demuxLogs(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let at = 0;
  while (at + 8 <= raw.length) {
    const stream = raw[at];
    const size = raw.readUInt32BE(at + 4);
    const payload = raw.subarray(at + 8, at + 8 + size);
    (stream === 2 ? err : out).push(payload);
    at += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

export function isDockerNotFound(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 404;
}

export function dockerMessage(error: unknown): string {
  const e = error as { json?: { message?: string }; message?: string };
  return e?.json?.message ?? e?.message ?? String(error);
}
