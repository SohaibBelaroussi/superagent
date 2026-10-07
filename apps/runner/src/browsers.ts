import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { type Duplex, PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { EnsureBrowserResult, RunnerBrowser } from '@superagent/shared/runner';
import type Docker from 'dockerode';
import type { RunnerConfig } from './config';
import { demuxLogs, dockerMessage, isDockerNotFound } from './docker';
import {
  browserLabel,
  browserName,
  browserSpec,
  identityVolume,
  isTaskId,
  LABELS,
  SANDBOX_USER,
} from './policy';
import { type Logger, RunnerError } from './sandboxes';

const TICKET_TTL_MS = 60_000;
/** How long Chromium may take to open DevTools after its container starts. */
const READY_TIMEOUT_MS = 30_000;
const DEVTOOLS = 'TCP:127.0.0.1:9222';
const CDP_PATH = /^\/browsers\/([0-9a-f-]{36})\/cdp$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seccomp profile Chromium needs for its own sandbox: shipped next to the runner bundle (the image)
 * or in the repository (dev). `none` runs Chromium without its sandbox, under Docker's default profile.
 */
export function loadBrowserSeccomp(setting: string): string | undefined {
  if (setting === 'none') return undefined;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates =
    setting === 'auto'
      ? [
          path.resolve(here, '../seccomp/chromium.json'),
          path.resolve(here, '../../../infra/browser/seccomp.json'),
        ]
      : [setting];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`No browser seccomp profile found (looked in ${candidates.join(', ')})`);
  return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * One browser container per task (decision D34), reached only through the runner: a DevTools connection
 * is relayed into the container with `docker exec socat`, so nothing in it listens on a network.
 */
export class BrowserContainers {
  private readonly lastUsed = new Map<string, number>();
  private readonly connections = new Map<string, number>();
  private readonly tickets = new Map<string, { taskId: string; expires: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly seccomp: string | undefined;

  constructor(
    private readonly docker: Docker,
    private readonly config: RunnerConfig,
    private readonly log: Logger,
  ) {
    this.seccomp = loadBrowserSeccomp(config.RUNNER_BROWSER_SECCOMP);
    if (!this.seccomp) log.warn("Browsers run without Chromium's sandbox (RUNNER_BROWSER_SECCOMP=none)");
  }

  /**
   * Gets the task's browser running, with the identity's profile if one, and a ticket to connect to it.
   * An identity is used by one browser at a time: another task's browser that holds it is stopped if
   * nobody is connected to it (the API's lock decides who may use an identity), else this is refused.
   */
  ensure(taskId: string, identityId?: string): Promise<EnsureBrowserResult> {
    this.requireId(taskId, 'task');
    if (identityId) this.requireId(identityId, 'identity');
    return this.locked(taskId, () =>
      identityId
        ? this.locked(`identity:${identityId}`, () => this.ensureNow(taskId, identityId))
        : this.ensureNow(taskId),
    );
  }

  async list(): Promise<RunnerBrowser[]> {
    return (await this.containers()).flatMap((c) => {
      const taskId = c.Labels[LABELS.task];
      if (!taskId) return [];
      const used = this.lastUsed.get(taskId);
      return [
        {
          taskId,
          container: (c.Names[0] ?? '').replace(/^\//, ''),
          identityId: c.Labels[LABELS.identity] ?? null,
          state: c.State === 'running' ? ('running' as const) : ('stopped' as const),
          createdAt: new Date(c.Created * 1000).toISOString(),
          lastUsedAt: used ? new Date(used).toISOString() : null,
          connections: this.connections.get(taskId) ?? 0,
        },
      ];
    });
  }

  async get(taskId: string): Promise<RunnerBrowser | undefined> {
    this.requireId(taskId, 'task');
    const info = await this.inspect(browserName(this.config, taskId));
    return info ? this.describe(info) : undefined;
  }

  /** Stops the task's browser (Chromium saves its identity's cookies on the way out) and removes it. */
  remove(taskId: string): Promise<boolean> {
    this.requireId(taskId, 'task');
    return this.locked(taskId, async () => {
      const removed = await this.stopAndRemove(browserName(this.config, taskId));
      if (removed) this.log.info('Browser removed', { taskId });
      return removed;
    });
  }

  /** Deletes an identity's profile. Refused while a browser runs with it; stopped ones go with it. */
  removeIdentity(identityId: string): Promise<boolean> {
    this.requireId(identityId, 'identity');
    return this.locked(`identity:${identityId}`, async () => {
      const using = (await this.containers()).filter((c) => c.Labels[LABELS.identity] === identityId);
      if (using.some((c) => c.State === 'running')) {
        throw new RunnerError(409, 'identity_in_use', 'A browser is using this identity: close it first');
      }
      for (const c of using) await this.docker.getContainer(c.Id).remove({ force: true });
      try {
        await this.docker.getVolume(identityVolume(this.config, identityId)).remove();
        return true;
      } catch (error) {
        if (isDockerNotFound(error)) return false;
        throw error;
      }
    });
  }

  /** Whether browsers can start: the image is built and the network exists (for the API's health checks). */
  ready(): Promise<boolean> {
    return this.requireReady().then(
      () => true,
      () => false,
    );
  }

  /** Whether an upgrade request is a DevTools connection, which `relay` serves. */
  handles(req: IncomingMessage): boolean {
    return CDP_PATH.test(new URL(req.url ?? '/', 'http://runner').pathname);
  }

  /**
   * Relays a DevTools WebSocket into the task's browser: the client's handshake goes to Chromium (with
   * the Host header DevTools accepts), then bytes flow both ways untouched. The ticket is the credential.
   */
  async relay(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://runner');
    const taskId = CDP_PATH.exec(url.pathname)?.[1];
    if (!taskId || !isTaskId(taskId)) return refuse(socket, 404, 'Not Found');
    if (!this.useTicket(taskId, url.searchParams.get('ticket') ?? '')) {
      return refuse(socket, 401, 'Unauthorized');
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      return refuse(socket, 400, 'Bad Request');
    }
    let stream: Duplex;
    let target: string;
    try {
      const container = this.docker.getContainer(browserName(this.config, taskId));
      target = await this.devtoolsPath(container);
      const exec = await container.exec({
        Cmd: ['socat', '-t', '5', 'STDIO', DEVTOOLS],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        User: SANDBOX_USER,
        Tty: false,
      });
      stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    } catch (error) {
      this.log.warn('A DevTools connection failed', { taskId, error: dockerMessage(error) });
      return refuse(socket, 502, 'Bad Gateway');
    }
    const extensions = req.headers['sec-websocket-extensions'];
    stream.write(
      [
        `GET ${target} HTTP/1.1`,
        'Host: 127.0.0.1:9222',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] ?? '13'}`,
        ...(typeof extensions === 'string' ? [`Sec-WebSocket-Extensions: ${extensions}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    if (head.length > 0) stream.write(head);
    this.connections.set(taskId, (this.connections.get(taskId) ?? 0) + 1);
    this.touch(taskId);
    let open = true;
    const done = () => {
      if (!open) return;
      open = false;
      const left = (this.connections.get(taskId) ?? 1) - 1;
      if (left > 0) this.connections.set(taskId, left);
      else this.connections.delete(taskId);
      this.touch(taskId);
    };
    const stdout = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, new PassThrough());
    stdout.pipe(socket);
    socket.on('data', (chunk: Buffer) => {
      this.touch(taskId);
      stream.write(chunk);
    });
    socket.on('end', () => stream.end());
    socket.on('close', () => {
      stream.destroy();
      done();
    });
    stream.on('error', () => socket.destroy());
    stream.on('end', () => socket.end());
    stream.on('close', () => {
      socket.destroy();
      done();
    });
  }

  /** Stops browsers nobody has used for a while and removes stopped ones. Identity profiles stay. */
  async reap(now = Date.now()): Promise<void> {
    for (const summary of await this.containers()) {
      const taskId = summary.Labels[LABELS.task];
      if (!taskId || !isTaskId(taskId)) continue;
      try {
        await this.locked(taskId, async () => {
          const container = this.docker.getContainer(summary.Id);
          const info = await container.inspect();
          if (info.State.Running) {
            const last = this.lastUsed.get(taskId) ?? Date.parse(info.State.StartedAt);
            const idle = now - last >= this.config.RUNNER_BROWSER_IDLE_STOP_MS;
            if ((this.connections.get(taskId) ?? 0) > 0 || !idle) return;
            await container.stop({ t: 10 });
            this.log.info('Browser stopped (idle)', { taskId });
          }
          // A stopped browser holds nothing worth keeping: an identity's profile is in its volume.
          await container.remove({ force: true });
        });
      } catch (error) {
        if (!isDockerNotFound(error)) {
          this.log.warn('Reaping a browser failed', { taskId, error: dockerMessage(error) });
        }
      }
    }
  }

  // --- helpers ---

  private async ensureNow(taskId: string, identityId?: string): Promise<EnsureBrowserResult> {
    const name = browserName(this.config, taskId);
    let info = await this.inspect(name);
    let outcome: 'created' | 'connected' = 'connected';
    // Started with another identity (or none): replaced, its profile saved on the way out.
    if (info && (info.Config.Labels[LABELS.identity] ?? undefined) !== identityId) {
      await this.stopAndRemove(name);
      info = undefined;
    }
    if (!info?.State.Running) {
      if (identityId) await this.freeIdentity(identityId, taskId);
      await this.requireReady();
      await this.makeRoom(taskId);
    }
    if (!info) {
      if (identityId) await this.createVolume(identityId);
      const container = await this.docker.createContainer(
        browserSpec(this.config, { taskId, identityId, seccomp: this.seccomp }),
      );
      await container.start();
      outcome = 'created';
      this.log.info('Browser started', { taskId, identityId: identityId ?? null });
    } else if (!info.State.Running) {
      await this.start(name);
    }
    await this.waitForDevtools(this.docker.getContainer(name));
    this.touch(taskId);
    const fresh = await this.inspect(name);
    if (!fresh) throw new RunnerError(503, 'browser_unavailable', 'The browser disappeared');
    return { ...this.describe(fresh), outcome, ticket: this.mintTicket(taskId) };
  }

  private async createVolume(identityId: string): Promise<void> {
    // Creating a volume that exists returns it unchanged.
    await this.docker.createVolume({
      Name: identityVolume(this.config, identityId),
      Labels: { [LABELS.runner]: browserLabel(this.config), [LABELS.identity]: identityId },
    });
  }

  /** Another task's browser running with the identity is stopped if idle, else this is refused. */
  private async freeIdentity(identityId: string, taskId: string): Promise<void> {
    const holders = (await this.containers()).filter(
      (c) =>
        c.State === 'running' && c.Labels[LABELS.identity] === identityId && c.Labels[LABELS.task] !== taskId,
    );
    for (const holder of holders) {
      const holderTask = holder.Labels[LABELS.task] ?? '';
      if ((this.connections.get(holderTask) ?? 0) > 0) {
        throw new RunnerError(409, 'identity_in_use', "Another task's browser is using this identity");
      }
      await this.docker.getContainer(holder.Id).stop({ t: 10 });
      this.log.info('Browser stopped to free its identity', { taskId: holderTask, for: taskId });
    }
  }

  /**
   * The path DevTools serves its browser endpoint on, asked over its own HTTP API from inside. DevTools
   * drops a request whose connection is half-closed before it answers, and keeps the connection open
   * after answering, so this keeps its side open and hangs up once the whole body has arrived.
   */
  private async devtoolsPath(container: Docker.Container): Promise<string> {
    const exec = await container.exec({
      Cmd: ['socat', '-t', '1', 'STDIO', DEVTOOLS],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      User: SANDBOX_USER,
      Tty: false,
    });
    const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    const out = new PassThrough();
    this.docker.modem.demuxStream(stream, out, new PassThrough());
    const body = await new Promise<string | undefined>((resolve) => {
      let raw = Buffer.alloc(0);
      const finish = (value?: string) => {
        clearTimeout(timer);
        stream.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(), 5_000);
      out.on('data', (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
        const headEnd = raw.indexOf('\r\n\r\n');
        if (headEnd < 0) return;
        const length = Number(
          /content-length:\s*(\d+)/i.exec(raw.subarray(0, headEnd).toString('latin1'))?.[1],
        );
        if (Number.isFinite(length) && raw.length >= headEnd + 4 + length) {
          finish(raw.subarray(headEnd + 4, headEnd + 4 + length).toString('utf8'));
        }
      });
      stream.on('error', () => finish());
      stream.on('close', () => finish());
      stream.write('GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n\r\n');
    });
    try {
      const info = JSON.parse(body ?? '') as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return new URL(info.webSocketDebuggerUrl).pathname;
    } catch {
      // not answering yet
    }
    throw new RunnerError(503, 'browser_unavailable', 'The browser is not answering yet');
  }

  private async waitForDevtools(container: Docker.Container): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.devtoolsPath(container);
        return;
      } catch (error) {
        const info = await container.inspect().catch(() => undefined);
        const running = Boolean(info?.State.Running);
        if (running && Date.now() < deadline) {
          await sleep(250);
          continue;
        }
        const raw = (await container.logs({ stdout: true, stderr: true, tail: 30 }).catch(() => undefined)) as
          | Buffer
          | undefined;
        const logs = raw ? demuxLogs(raw) : { stdout: '', stderr: '' };
        this.log.error('The browser did not start', { logs: `${logs.stdout}${logs.stderr}`.slice(-2000) });
        if (!(error instanceof RunnerError)) throw error;
        throw new RunnerError(503, 'browser_unavailable', running ? error.message : 'The browser exited');
      }
    }
  }

  /** The browser image and network must exist: the runner never pulls, and compose creates the network. */
  private async requireReady(): Promise<void> {
    try {
      await this.docker.getImage(this.config.RUNNER_BROWSER_IMAGE).inspect();
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      throw new RunnerError(
        503,
        'image_missing',
        `The browser image ${this.config.RUNNER_BROWSER_IMAGE} is not built`,
      );
    }
    try {
      await this.docker.getNetwork(this.config.RUNNER_BROWSER_NETWORK).inspect();
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      throw new RunnerError(
        503,
        'browser_unavailable',
        `The ${this.config.RUNNER_BROWSER_NETWORK} network is missing`,
      );
    }
  }

  /** At the running limit, stops the least recently used browser nobody is connected to, or refuses. */
  private async makeRoom(taskId: string): Promise<void> {
    const running = (await this.containers()).filter(
      (c) => c.State === 'running' && c.Labels[LABELS.task] !== taskId,
    );
    if (running.length < this.config.RUNNER_MAX_BROWSERS) return;
    const victim = running
      .map((c) => ({ id: c.Id, taskId: c.Labels[LABELS.task] ?? '' }))
      .filter((c) => (this.connections.get(c.taskId) ?? 0) === 0)
      .sort((a, b) => (this.lastUsed.get(a.taskId) ?? 0) - (this.lastUsed.get(b.taskId) ?? 0))[0];
    if (!victim) {
      throw new RunnerError(
        503,
        'browsers_busy',
        `${running.length} browsers are in use (the limit is ${this.config.RUNNER_MAX_BROWSERS})`,
      );
    }
    await this.docker.getContainer(victim.id).stop({ t: 10 });
    this.log.info('Browser stopped to make room', { taskId: victim.taskId, for: taskId });
  }

  private async stopAndRemove(name: string): Promise<boolean> {
    const container = this.docker.getContainer(name);
    try {
      await container.stop({ t: 10 });
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      if ((error as { statusCode?: number }).statusCode !== 304) throw error; // 304: already stopped
    }
    try {
      await container.remove({ force: true });
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
    return true;
  }

  private mintTicket(taskId: string): string {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) if (entry.expires < now) this.tickets.delete(ticket);
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { taskId, expires: now + TICKET_TTL_MS });
    return ticket;
  }

  /** A ticket works once, for its own task, within its minute. */
  private useTicket(taskId: string, ticket: string): boolean {
    const given = Buffer.from(ticket);
    for (const [known, entry] of this.tickets) {
      const expected = Buffer.from(known);
      if (expected.length === given.length && timingSafeEqual(expected, given)) {
        this.tickets.delete(known);
        return entry.taskId === taskId && entry.expires >= Date.now();
      }
    }
    return false;
  }

  private containers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${browserLabel(this.config)}`] },
    });
  }

  private async inspect(name: string): Promise<Docker.ContainerInspectInfo | undefined> {
    try {
      return await this.docker.getContainer(name).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) return undefined;
      throw error;
    }
  }

  private async start(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).start();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 304) throw error;
    }
  }

  private describe(info: Docker.ContainerInspectInfo): RunnerBrowser {
    const taskId = info.Config.Labels[LABELS.task] ?? '';
    const used = this.lastUsed.get(taskId);
    return {
      taskId,
      container: info.Name.replace(/^\//, ''),
      identityId: info.Config.Labels[LABELS.identity] ?? null,
      state: info.State.Running ? 'running' : 'stopped',
      createdAt: new Date(info.Created).toISOString(),
      lastUsedAt: used ? new Date(used).toISOString() : null,
      connections: this.connections.get(taskId) ?? 0,
    };
  }

  private touch(taskId: string): void {
    this.lastUsed.set(taskId, Date.now());
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  private requireId(id: string, what: string): void {
    if (!isTaskId(id)) throw new RunnerError(400, 'invalid_request', `Not a ${what} id`);
  }
}
