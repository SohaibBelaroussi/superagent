import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type Duplex, PassThrough } from 'node:stream';
import type {
  McpInstallInput,
  McpInstallResult,
  McpLaunch,
  RunnerMcpPackage,
} from '@superagent/shared/runner';
import type Docker from 'dockerode';
import type { RunnerConfig } from './config';
import { dockerMessage, execIn, isDockerNotFound } from './docker';
import {
  isTaskId,
  LABELS,
  mcpLabel,
  mcpName,
  mcpSpec,
  mcpVolumes,
  mcpWorkerSpec,
  PLUGIN_ROOT,
  SANDBOX_USER,
} from './policy';
import { type Logger, RunnerError } from './sandboxes';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** How long one call may wait for its server's answer. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const WORKER_MAX_AGE_MS = 30 * 60_000;

/** Resolves an npm package's executable (its one bin, or the one asked for) and its version. */
const NPM_RESOLVE = `
const path = require('path');
const [dir, name, wanted] = process.argv.slice(1);
const root = path.join(dir, 'node_modules', name);
const pkg = require(path.join(root, 'package.json'));
const bins = typeof pkg.bin === 'string' ? { [name.split('/').pop()]: pkg.bin } : pkg.bin || {};
const names = Object.keys(bins);
const base = name.split('/').pop();
const pick = wanted ? (bins[wanted] ? wanted : undefined) : names.length === 1 ? names[0] : bins[base] ? base : undefined;
if (!pick) console.log(JSON.stringify({ error: 'no executable to run' + (names.length ? ': name one of ' + names.join(', ') : '') }));
else console.log(JSON.stringify({ executable: path.join(root, bins[pick]), version: pkg.version }));
`;

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Child {
  write(text: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/**
 * The Streamable HTTP side of one stdio MCP server (the 2025 revision: JSON responses, a session id).
 * Messages are framed by lines; responses are matched to requests by id; the server's own requests
 * (sampling, roots, elicitation) are answered "not supported" and its notifications dropped. A new
 * `initialize` starts a new process, as a stdio server takes only one.
 */
class StdioRelay {
  private child: Child | undefined;
  private session: string | undefined;
  private readonly pending = new Map<
    string,
    { resolve(message: unknown): void; reject(error: Error): void }
  >();

  constructor(
    private readonly open: () => Promise<Child>,
    private readonly log: Logger,
    private readonly serverId: string,
  ) {}

  get active(): boolean {
    return Boolean(this.child);
  }

  async handle(method: string, sessionId: string | undefined, body: string): Promise<RelayResponse> {
    const json = (
      status: number,
      payload?: unknown,
      headers: Record<string, string> = {},
    ): RelayResponse => ({
      status,
      headers: { 'content-type': 'application/json', ...headers },
      body: payload === undefined ? '' : JSON.stringify(payload),
    });
    const rpcError = (status: number, code: number, message: string, id: unknown = null) =>
      json(status, { jsonrpc: '2.0', error: { code, message }, id });
    if (method === 'DELETE') {
      this.close('The session ended');
      return json(200, {});
    }
    if (method !== 'POST') return json(405, undefined, { allow: 'POST, DELETE' });
    if (body.length > MAX_MESSAGE_BYTES) return rpcError(413, -32600, 'Message too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return rpcError(400, -32700, 'Parse error');
    }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
    if (messages.some((m) => m?.method === 'initialize')) await this.start();
    else if (!this.child || sessionId !== this.session) {
      // An unknown session (stopped idle, or the runner restarted): 404 makes the client start over.
      return rpcError(sessionId ? 404 : 400, -32000, 'No valid session');
    }
    const child = this.child as Child;
    const requests = messages.filter((m) => m?.method && m.id !== undefined);
    for (const message of messages) {
      if (!(message?.method && message.id !== undefined)) child.write(`${JSON.stringify(message)}\n`);
    }
    const session = { 'mcp-session-id': this.session as string };
    if (requests.length === 0) return json(202, undefined, session);
    try {
      const answers = await Promise.all(requests.map((message) => this.call(child, message)));
      return json(200, Array.isArray(parsed) ? answers : answers[0], session);
    } catch (error) {
      return rpcError(502, -32603, (error as Error).message, requests[0]?.id ?? null);
    }
  }

  close(reason = 'The relay closed'): void {
    this.child?.close();
    this.child = undefined;
    this.session = undefined;
    this.failAll(reason);
  }

  private async start(): Promise<void> {
    this.close('The MCP server restarted');
    const child = await this.open();
    child.onLine((line) => this.fromChild(child, line));
    child.onClose(() => {
      if (this.child !== child) return;
      this.child = undefined;
      this.session = undefined;
      this.failAll('The MCP server exited');
    });
    this.child = child;
    this.session = randomUUID();
  }

  private call(child: Child, message: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const key = String(message.id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('The MCP server did not answer in time'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(key, {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.write(`${JSON.stringify(message)}\n`);
    });
  }

  private fromChild(child: Child, line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log.debug('An MCP server wrote a line that is not JSON', { serverId: this.serverId });
      return;
    }
    if (message.id !== undefined && message.method) {
      // The server asks the client something: ping is answered, nothing else is offered.
      const answer =
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `${String(message.method)} is not supported` },
            };
      child.write(`${JSON.stringify(answer)}\n`);
      return;
    }
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const waiting = this.pending.get(String(message.id));
      if (waiting) {
        this.pending.delete(String(message.id));
        waiting.resolve(message);
      }
    }
  }

  private failAll(reason: string): void {
    for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
    this.pending.clear();
  }
}

/**
 * stdio MCP servers (decision D36): one container per package (a plugin), from the MCP image, its
 * files and installed packages in a volume mounted read-only. Each server is a process the runner
 * execs, its stdio relayed as a Streamable HTTP endpoint (/mcp/servers/:id), so nothing in the
 * container listens on a network. How a server starts (its launch) is kept in memory only.
 */
export class McpPackages {
  private readonly launches = new Map<string, McpLaunch>();
  private readonly relays = new Map<string, StdioRelay>();
  private readonly lastUsed = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly docker: Docker,
    private readonly config: RunnerConfig,
    private readonly log: Logger,
  ) {}

  /** Replaces the package's files (a tar of its plugin folder) at /opt/plugin. */
  files(packageId: string, tar: Buffer): Promise<void> {
    this.requireId(packageId);
    return this.locked(packageId, async () => {
      await this.prepare(packageId);
      await this.worker(packageId, { install: false }, async (container) => {
        const outcome = await execIn(this.docker, container, {
          cmd: [
            'sh',
            '-c',
            'find "$1" -mindepth 1 -delete && tar -xpf - -C "$1" --no-same-owner',
            'sh',
            PLUGIN_ROOT,
          ],
          user: SANDBOX_USER,
          stdin: tar,
          maxOutputBytes: 64 * 1024,
          deadlineMs: 120_000,
        });
        if (outcome.exitCode !== 0) {
          throw new RunnerError(
            400,
            'invalid_request',
            `The plugin's files could not be written: ${outcome.stderr.toString('utf8').slice(-500)}`,
          );
        }
      });
    });
  }

  /** Installs servers' packages into the package's volume, through the egress proxy, scripts off. */
  install(packageId: string, input: McpInstallInput): Promise<McpInstallResult> {
    this.requireId(packageId);
    return this.locked(packageId, async () => {
      await this.prepare(packageId);
      await this.requireReady();
      const results: McpInstallResult['servers'] = [];
      await this.worker(packageId, { install: true }, async (container) => {
        for (const server of input.servers) {
          results.push(
            await (server.runtime === 'npm'
              ? this.installNpm(container, server)
              : this.installUv(container, server)
            ).catch((error: unknown) => ({
              key: server.key,
              ok: false,
              executable: null,
              version: null,
              lockfile: null,
              log: dockerMessage(error).slice(-2000),
            })),
          );
        }
      });
      return { servers: results };
    });
  }

  /** Remembers how a server starts (its process restarts with the new launch). */
  launch(serverId: string, spec: McpLaunch): void {
    this.requireId(serverId);
    this.requireId(spec.packageId);
    this.launches.set(serverId, spec);
    this.relays.get(serverId)?.close('The server was relaunched');
    this.relays.delete(serverId);
  }

  /** One Streamable HTTP request for a server. */
  async handle(
    serverId: string,
    method: string,
    sessionId: string | undefined,
    body: string,
  ): Promise<RelayResponse> {
    this.requireId(serverId);
    const spec = this.launches.get(serverId);
    if (!spec)
      throw new RunnerError(409, 'launch_unknown', 'The runner does not know how to start this server');
    let relay = this.relays.get(serverId);
    if (!relay) {
      relay = new StdioRelay(() => this.openServer(serverId), this.log, serverId);
      this.relays.set(serverId, relay);
    }
    this.lastUsed.set(spec.packageId, Date.now());
    try {
      return await relay.handle(method, sessionId, body);
    } finally {
      this.lastUsed.set(spec.packageId, Date.now());
    }
  }

  /** Removes the package's container, and its volumes too when asked (uninstall). */
  remove(packageId: string, volumes: boolean): Promise<void> {
    this.requireId(packageId);
    return this.locked(packageId, async () => {
      for (const [serverId, spec] of this.launches) {
        if (spec.packageId !== packageId) continue;
        this.relays.get(serverId)?.close('The package was removed');
        this.relays.delete(serverId);
        this.launches.delete(serverId);
      }
      await this.removeContainer(mcpName(this.config, packageId));
      this.lastUsed.delete(packageId);
      if (!volumes) return;
      const workers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`${LABELS.runner}=${mcpLabel(this.config)}-worker`, `${LABELS.mcpPackage}=${packageId}`],
        },
      });
      for (const worker of workers)
        await this.docker
          .getContainer(worker.Id)
          .remove({ force: true })
          .catch(() => {});
      const { opt, data } = mcpVolumes(this.config, packageId);
      for (const name of [opt, data]) {
        await this.docker
          .getVolume(name)
          .remove()
          .catch((error: unknown) => {
            if (!isDockerNotFound(error)) throw error;
          });
      }
      this.log.info('MCP package removed', { packageId });
    });
  }

  async list(): Promise<RunnerMcpPackage[]> {
    const containers = await this.containers();
    const ids = new Set([
      ...containers.map((c) => c.Labels[LABELS.mcpPackage] ?? ''),
      ...[...this.launches.values()].map((spec) => spec.packageId),
    ]);
    ids.delete('');
    return [...ids].map((packageId) => {
      const container = containers.find((c) => c.Labels[LABELS.mcpPackage] === packageId);
      const used = this.lastUsed.get(packageId);
      return {
        packageId,
        container: container ? (container.Names[0] ?? '').replace(/^\//, '') : null,
        state: !container ? 'absent' : container.State === 'running' ? 'running' : 'stopped',
        servers: [...this.launches.entries()]
          .filter(([, spec]) => spec.packageId === packageId)
          .map(([id]) => id),
        lastUsedAt: used ? new Date(used).toISOString() : null,
      };
    });
  }

  /** Whether MCP servers can start: the image is built and the network exists. */
  ready(): Promise<boolean> {
    return this.requireReady().then(
      () => true,
      () => false,
    );
  }

  /** Stops packages nobody has called for a while, removes stopped ones and old workers. */
  async reap(now = Date.now()): Promise<void> {
    for (const summary of await this.containers()) {
      const packageId = summary.Labels[LABELS.mcpPackage];
      if (!packageId || !isTaskId(packageId)) continue;
      try {
        await this.locked(packageId, async () => {
          const container = this.docker.getContainer(summary.Id);
          const info = await container.inspect();
          if (info.State.Running) {
            const last = this.lastUsed.get(packageId) ?? Date.parse(info.State.StartedAt);
            if (now - last < this.config.RUNNER_MCP_IDLE_STOP_MS) return;
            this.closeRelays(packageId, 'The server was stopped (idle)');
            await container.stop({ t: 5 });
            this.log.info('MCP package stopped (idle)', { packageId });
          }
          await container.remove({ force: true });
        });
      } catch (error) {
        if (!isDockerNotFound(error)) {
          this.log.warn('Reaping an MCP package failed', { packageId, error: dockerMessage(error) });
        }
      }
    }
    const workers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${mcpLabel(this.config)}-worker`] },
    });
    for (const worker of workers) {
      if (now - worker.Created * 1000 < WORKER_MAX_AGE_MS) continue;
      await this.docker
        .getContainer(worker.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }

  // --- helpers ---

  /** Starts the server's process in its package's container and wires its stdio. */
  private async openServer(serverId: string): Promise<Child> {
    const spec = this.launches.get(serverId);
    if (!spec)
      throw new RunnerError(409, 'launch_unknown', 'The runner does not know how to start this server');
    const container = await this.locked(spec.packageId, () => this.ensureContainer(spec));
    const exec = await container.exec({
      Cmd: spec.command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: SANDBOX_USER,
      WorkingDir: spec.cwd ?? PLUGIN_ROOT,
      // Secrets reach this process only, never the container's configuration.
      Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
    });
    const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    const out = new PassThrough();
    const err = new PassThrough();
    this.docker.modem.demuxStream(stream, out, err);
    stream.on('end', () => {
      out.end();
      err.end();
    });
    stream.on('error', () => stream.destroy());
    err.on('data', (chunk: Buffer) =>
      this.log.debug('MCP server stderr', { serverId, text: chunk.toString('utf8').slice(0, 500) }),
    );
    const lines = createInterface({ input: out, crlfDelay: Number.POSITIVE_INFINITY });
    return {
      write: (text) => {
        if (!stream.destroyed) stream.write(text);
      },
      onLine: (listener) => {
        lines.on('line', listener);
      },
      onClose: (listener) => {
        stream.on('close', listener);
      },
      // Closing stdin ends a well-behaved server; the container's stop takes care of the rest.
      close: () => {
        stream.end();
        stream.destroy();
      },
    };
  }

  private async ensureContainer(spec: McpLaunch): Promise<Docker.Container> {
    const name = mcpName(this.config, spec.packageId);
    let info = await this.inspect(name);
    // Started with another network setting: replaced.
    if (info && info.Config.Labels[LABELS.mcpNetwork] !== spec.network) {
      this.closeRelays(spec.packageId, 'The package was restarted');
      await this.removeContainer(name);
      info = undefined;
    }
    if (info?.State.Running) return this.docker.getContainer(name);
    await this.requireReady(spec.network);
    await this.makeRoom(spec.packageId);
    if (!info) {
      const container = await this.docker.createContainer(
        mcpSpec(this.config, { packageId: spec.packageId, network: spec.network }),
      );
      await container.start();
      this.log.info('MCP package started', { packageId: spec.packageId, network: spec.network });
      return container;
    }
    const container = this.docker.getContainer(name);
    await container.start().catch((error: unknown) => {
      if ((error as { statusCode?: number }).statusCode !== 304) throw error;
    });
    return container;
  }

  /** At the running limit, stops the least recently used package nobody is calling, or refuses. */
  private async makeRoom(packageId: string): Promise<void> {
    const running = (await this.containers()).filter(
      (c) => c.State === 'running' && c.Labels[LABELS.mcpPackage] !== packageId,
    );
    if (running.length < this.config.RUNNER_MAX_MCP) return;
    const victim = running
      .map((c) => ({ id: c.Id, packageId: c.Labels[LABELS.mcpPackage] ?? '' }))
      .sort((a, b) => (this.lastUsed.get(a.packageId) ?? 0) - (this.lastUsed.get(b.packageId) ?? 0))[0];
    if (!victim) throw new RunnerError(503, 'mcp_busy', 'Too many MCP packages are running');
    this.closeRelays(victim.packageId, 'The server was stopped to make room');
    await this.docker.getContainer(victim.id).stop({ t: 5 });
    this.log.info('MCP package stopped to make room', { packageId: victim.packageId, for: packageId });
  }

  private closeRelays(packageId: string, reason: string): void {
    for (const [serverId, spec] of this.launches) {
      if (spec.packageId !== packageId) continue;
      this.relays.get(serverId)?.close(reason);
      this.relays.delete(serverId);
    }
  }

  /** The package's volumes exist, and their folders belong to the sandbox user. */
  private async prepare(packageId: string): Promise<void> {
    const { opt, data } = mcpVolumes(this.config, packageId);
    const labels = { [LABELS.runner]: mcpLabel(this.config), [LABELS.mcpPackage]: packageId };
    await this.docker.createVolume({ Name: opt, Labels: labels });
    await this.docker.createVolume({ Name: data, Labels: labels });
    await this.worker(packageId, { install: false, asRoot: true }, async (container) => {
      const outcome = await execIn(this.docker, container, {
        cmd: [
          'sh',
          '-c',
          'mkdir -p /opt/plugin /opt/pkgs && chown 1000:1000 /opt /opt/plugin /opt/pkgs /data',
        ],
        user: '0:0',
        maxOutputBytes: 16 * 1024,
        deadlineMs: 60_000,
      });
      if (outcome.exitCode !== 0) {
        throw new Error(`Preparing the package's volumes failed: ${outcome.stderr.toString('utf8')}`);
      }
    });
  }

  /** Runs work in a short-lived worker container on the package's volumes, then removes it. */
  private async worker<T>(
    packageId: string,
    options: { install: boolean; asRoot?: boolean },
    work: (container: Docker.Container) => Promise<T>,
  ): Promise<T> {
    if (options.install) await this.requireReady('egress');
    else await this.requireImage();
    const container = await this.docker.createContainer(
      mcpWorkerSpec(this.config, {
        packageId,
        cmd: ['sleep', String(Math.ceil(this.config.RUNNER_MCP_INSTALL_TIMEOUT_MS / 1000) + 120)],
        asRoot: options.asRoot,
        install: options.install,
      }),
    );
    try {
      await container.start();
      return await work(container);
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  private async run(
    container: Docker.Container,
    cmd: string[],
    workingDir?: string,
  ): Promise<{ ok: boolean; out: string; log: string }> {
    const outcome = await execIn(this.docker, container, {
      cmd,
      user: SANDBOX_USER,
      workingDir,
      maxOutputBytes: 2 * 1024 * 1024,
      deadlineMs: this.config.RUNNER_MCP_INSTALL_TIMEOUT_MS,
    });
    const out = outcome.stdout.toString('utf8');
    const log = `${out}${outcome.stderr.toString('utf8')}`.slice(-4000);
    return { ok: outcome.exitCode === 0 && !outcome.abandoned, out, log };
  }

  private async installNpm(
    container: Docker.Container,
    server: McpInstallInput['servers'][number],
  ): Promise<McpInstallResult['servers'][number]> {
    const dir = `/opt/pkgs/${server.key}`;
    const fail = (log: string) => ({
      key: server.key,
      ok: false,
      executable: null,
      version: null,
      lockfile: null,
      log,
    });
    const steps: Array<[string[], string | undefined]> = [
      [['sh', '-c', 'rm -rf "$1" && mkdir -p "$1"', 'sh', dir], undefined],
      [['npm', 'init', '-y'], dir],
      [
        [
          'npm',
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--omit=dev',
          '--save-exact',
          `${server.package}@${server.version}`,
        ],
        dir,
      ],
    ];
    let log = '';
    for (const [cmd, cwd] of steps) {
      const step = await this.run(container, cmd, cwd);
      log = step.log;
      if (!step.ok) return fail(log);
    }
    const resolved = await this.run(container, [
      'node',
      '-e',
      NPM_RESOLVE,
      dir,
      server.package,
      server.bin ?? '',
    ]);
    const answer = JSON.parse(resolved.out.trim() || '{}') as {
      executable?: string;
      version?: string;
      error?: string;
    };
    if (!answer.executable) return fail(answer.error ?? resolved.log);
    const lock = await this.run(container, ['cat', `${dir}/package-lock.json`]);
    return {
      key: server.key,
      ok: true,
      executable: answer.executable,
      version: answer.version ?? null,
      lockfile: lock.ok ? lock.out : null,
      log,
    };
  }

  private async installUv(
    container: Docker.Container,
    server: McpInstallInput['servers'][number],
  ): Promise<McpInstallResult['servers'][number]> {
    const dir = `/opt/pkgs/${server.key}`;
    const python = `${dir}/venv/bin/python`;
    const fail = (log: string) => ({
      key: server.key,
      ok: false,
      executable: null,
      version: null,
      lockfile: null,
      log,
    });
    const steps: string[][] = [
      ['sh', '-c', 'rm -rf "$1" && mkdir -p "$1"', 'sh', dir],
      ['uv', 'venv', `${dir}/venv`],
      [
        'uv',
        'pip',
        'install',
        '--python',
        python,
        // Wheels only: no package's build code runs here.
        '--only-binary',
        ':all:',
        server.version === 'latest' ? server.package : `${server.package}==${server.version}`,
      ],
    ];
    let log = '';
    for (const cmd of steps) {
      const step = await this.run(container, cmd);
      log = step.log;
      if (!step.ok) return fail(log);
    }
    const freeze = await this.run(container, ['uv', 'pip', 'freeze', '--python', python]);
    const executable = `${dir}/venv/bin/${server.bin ?? server.package}`;
    const exists = await this.run(container, ['test', '-x', executable]);
    if (!exists.ok) return fail(`No executable ${server.bin ?? server.package} in the package`);
    const normalized = server.package.toLowerCase().replace(/[-_.]+/g, '-');
    const version = freeze.out
      .split('\n')
      .map((line) => line.trim().split('=='))
      .find(([name]) => name?.toLowerCase().replace(/[-_.]+/g, '-') === normalized)?.[1];
    return { key: server.key, ok: true, executable, version: version ?? null, lockfile: freeze.out, log };
  }

  private async requireImage(): Promise<void> {
    try {
      await this.docker.getImage(this.config.RUNNER_MCP_IMAGE).inspect();
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      throw new RunnerError(
        503,
        'image_missing',
        `The MCP image ${this.config.RUNNER_MCP_IMAGE} is not built`,
      );
    }
  }

  /** The image, and the network when the work needs one. */
  private async requireReady(network: 'egress' | 'none' = 'egress'): Promise<void> {
    await this.requireImage();
    if (network === 'none') return;
    try {
      await this.docker.getNetwork(this.config.RUNNER_MCP_NETWORK).inspect();
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      throw new RunnerError(
        503,
        'mcp_unavailable',
        `The ${this.config.RUNNER_MCP_NETWORK} network is missing`,
      );
    }
  }

  private containers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.runner}=${mcpLabel(this.config)}`] },
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

  private async removeContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
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

  private requireId(id: string): void {
    if (!isTaskId(id)) throw new RunnerError(400, 'invalid_request', 'Not an id');
  }
}
