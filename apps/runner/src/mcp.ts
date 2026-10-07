import { randomUUID } from 'node:crypto';
import { type Duplex, PassThrough, type Readable } from 'node:stream';
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
  mcpNetworkName,
  mcpSpec,
  mcpVolumes,
  mcpWorkerSpec,
  PLUGIN_ROOT,
  SANDBOX_USER,
} from './policy';
import { type Logger, RunnerError } from './sandboxes';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** One message (a line) from a server may weigh this much; a longer one stops the server. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** How long one call may wait for its server's answer. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const WORKER_MAX_AGE_MS = 30 * 60_000;
/** Writes the shell's pid, then becomes the server (same pid): a server can be stopped by it. */
const WITH_PID_FILE = 'echo $$ > "$1"; shift; exec "$@"';
/** Stops the process in a pid file: TERM, then KILL after 5 s (a server may ignore its input ending). */
const STOP_BY_PID_FILE =
  'p=$(cat "$1" 2>/dev/null) || exit 0; rm -f "$1"; kill -TERM "$p" 2>/dev/null || exit 0; ' +
  'for i in 1 2 3 4 5; do sleep 1; kill -0 "$p" 2>/dev/null || exit 0; done; kill -KILL "$p" 2>/dev/null; exit 0';

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

/** What a server's process tells its relay. */
interface ChildEvents {
  line(text: string): void;
  close(reason: string): void;
}

interface Child {
  write(text: string): void;
  close(): void;
}

/**
 * Splits a stream into lines (LF; a CR before it is dropped) of at most `max` bytes. A longer line
 * calls `overflow` once and nothing more is read: a server can't make the runner buffer without bound.
 */
export function splitLines(
  input: Readable,
  max: number,
  onLine: (line: string) => void,
  overflow: () => void,
): void {
  let parts: Buffer[] = [];
  let size = 0;
  let stopped = false;
  input.on('data', (chunk: Buffer) => {
    let start = 0;
    while (!stopped && start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      size += piece.length;
      if (size > max) {
        stopped = true;
        parts = [];
        overflow();
        return;
      }
      parts.push(piece);
      if (end === -1) return;
      const text = Buffer.concat(parts, size).toString('utf8');
      parts = [];
      size = 0;
      start = end + 1;
      onLine(text.endsWith('\r') ? text.slice(0, -1) : text);
    }
  });
}

/**
 * The Streamable HTTP side of one stdio MCP server (the 2025 revision: JSON responses, a session id).
 * Messages are framed by lines; responses are matched to requests by id; the server's own requests
 * (sampling, roots, elicitation) are answered "not supported" and its notifications dropped. A new
 * `initialize` starts a new process, as a stdio server takes only one; starts never overlap.
 */
class StdioRelay {
  private child: Child | undefined;
  private session: string | undefined;
  private starts: Promise<unknown> = Promise.resolve();
  /** Replaced (a new launch) or removed: a start still under way must not leave a process behind. */
  private disposed = false;
  private readonly pending = new Map<
    string,
    { resolve(message: unknown): void; reject(error: Error): void }
  >();

  constructor(
    private readonly open: (events: ChildEvents) => Promise<Child>,
    private readonly log: Logger,
    private readonly serverId: string,
  ) {}

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
    // An unknown session (stopped idle, replaced, or the runner restarted): 404 makes the client start over.
    const current = Boolean(this.child && sessionId && sessionId === this.session);
    if (method === 'DELETE') {
      // Only the session's own client ends it: an old client's goodbye never stops a newer session.
      if (!current) return rpcError(404, -32000, 'No valid session');
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
    let child: Child;
    let session: string;
    if (messages.some((m) => m?.method === 'initialize')) ({ child, session } = await this.restart());
    else if (current) {
      child = this.child as Child;
      session = this.session as string;
    } else return rpcError(sessionId ? 404 : 400, -32000, 'No valid session');
    const requests = messages.filter((m) => m?.method && m.id !== undefined);
    for (const message of messages) {
      if (!(message?.method && message.id !== undefined)) child.write(`${JSON.stringify(message)}\n`);
    }
    const headers = { 'mcp-session-id': session };
    if (requests.length === 0) return json(202, undefined, headers);
    try {
      const answers = await Promise.all(requests.map((message) => this.call(child, message)));
      return json(200, Array.isArray(parsed) ? answers : answers[0], headers);
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

  /** Closes the relay for good: the runner has forgotten it. */
  dispose(reason: string): void {
    this.disposed = true;
    this.close(reason);
  }

  /** A new process and session, after any start already under way. */
  private restart(): Promise<{ child: Child; session: string }> {
    const next = this.starts.then(
      () => this.start(),
      () => this.start(),
    );
    this.starts = next.catch(() => undefined);
    return next;
  }

  private async start(): Promise<{ child: Child; session: string }> {
    this.close('The MCP server restarted');
    const gone = () => new RunnerError(503, 'mcp_unavailable', 'The server was restarted: try again');
    if (this.disposed) throw gone();
    let child: Child | undefined;
    let ended: string | undefined;
    child = await this.open({
      line: (text) => {
        if (child) this.fromChild(child, text);
      },
      close: (reason) => {
        ended = reason;
        if (!child || this.child !== child) return;
        this.child = undefined;
        this.session = undefined;
        this.failAll(reason);
      },
    });
    if (ended) throw new RunnerError(502, 'mcp_unavailable', ended);
    if (this.disposed) {
      child.close();
      throw gone();
    }
    this.child = child;
    this.session = randomUUID();
    return { child, session: this.session };
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
    if (!message || typeof message !== 'object') return;
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
 * files and installed packages in a volume mounted read-only, on a network of its own that only the
 * egress proxy joins. Each server is a process the runner execs, its stdio relayed as a Streamable
 * HTTP endpoint (/mcp/servers/:id), so nothing in the container listens on a network. How a server
 * starts (its launch) is kept in memory only. A removed package stays removed: nothing late (an
 * install, a launch) brings it back.
 */
export class McpPackages {
  private readonly launches = new Map<string, McpLaunch>();
  private readonly relays = new Map<string, StdioRelay>();
  private readonly lastUsed = new Map<string, number>();
  /** Requests being answered, by package: such a package is never stopped to make room. */
  private readonly inFlight = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly removed = new Set<string>();

  constructor(
    private readonly docker: Docker,
    private readonly config: RunnerConfig,
    private readonly log: Logger,
  ) {}

  /** Replaces the package's files (a tar of its plugin folder) at /opt/plugin. */
  files(packageId: string, tar: Buffer): Promise<void> {
    this.requireLive(packageId);
    return this.locked(packageId, async () => {
      this.requireLive(packageId);
      await this.prepare(packageId);
      await this.worker(packageId, { lifetimeMs: 180_000 }, async (container) => {
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
    this.requireLive(packageId);
    return this.locked(packageId, async () => {
      this.requireLive(packageId);
      await this.requireReady();
      await this.prepare(packageId);
      const results: McpInstallResult['servers'] = [];
      const timeout = this.config.RUNNER_MCP_INSTALL_TIMEOUT_MS;
      const lifetimeMs = timeout * input.servers.length + 120_000;
      await this.worker(packageId, { install: true, lifetimeMs }, async (container) => {
        for (const server of input.servers) {
          const deadline = Date.now() + timeout;
          results.push(
            await (server.runtime === 'npm'
              ? this.installNpm(container, server, deadline)
              : this.installUv(container, server, deadline)
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
    this.requireLive(spec.packageId);
    this.launches.set(serverId, spec);
    this.closeRelay(serverId, 'The server was relaunched');
  }

  /** Forgets how a server starts and stops its process (it was disabled). */
  forget(serverId: string): void {
    this.requireId(serverId);
    this.launches.delete(serverId);
    this.closeRelay(serverId, 'The server was disabled');
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
      relay = new StdioRelay((events) => this.openServer(serverId, events), this.log, serverId);
      this.relays.set(serverId, relay);
    }
    const { packageId } = spec;
    this.lastUsed.set(packageId, Date.now());
    this.inFlight.set(packageId, (this.inFlight.get(packageId) ?? 0) + 1);
    try {
      return await relay.handle(method, sessionId, body);
    } finally {
      const left = (this.inFlight.get(packageId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(packageId, left);
      else this.inFlight.delete(packageId);
      this.lastUsed.set(packageId, Date.now());
    }
  }

  /**
   * Removes the package's container and network, and its volumes too when asked (uninstall). An
   * uninstalled package can't come back, and its work in progress (an install) stops at once.
   */
  async remove(packageId: string, volumes: boolean): Promise<void> {
    this.requireId(packageId);
    if (volumes) {
      this.removed.add(packageId);
      await this.removeWorkers(packageId);
    }
    await this.locked(packageId, async () => {
      for (const [serverId, spec] of this.launches) {
        if (spec.packageId !== packageId) continue;
        this.closeRelay(serverId, 'The package was removed');
        this.launches.delete(serverId);
      }
      await this.removeContainer(mcpName(this.config, packageId));
      await this.removeWorkers(packageId);
      this.lastUsed.delete(packageId);
      if (volumes) {
        const { opt, data } = mcpVolumes(this.config, packageId);
        for (const name of [opt, data]) {
          await this.docker
            .getVolume(name)
            .remove()
            .catch((error: unknown) => {
              if (!isDockerNotFound(error)) throw error;
            });
        }
      }
      await this.dropNetwork(packageId);
      if (volumes) this.log.info('MCP package removed', { packageId });
    });
  }

  /** Packages with a container, a launch or volumes. */
  async list(): Promise<RunnerMcpPackage[]> {
    const containers = await this.containers();
    const { Volumes: volumes } = await this.docker.listVolumes({
      filters: { label: [`${LABELS.runner}=${mcpLabel(this.config)}`] },
    });
    const ids = new Set([
      ...containers.map((c) => c.Labels[LABELS.mcpPackage] ?? ''),
      ...[...this.launches.values()].map((spec) => spec.packageId),
      ...(volumes ?? []).map((volume) => volume.Labels?.[LABELS.mcpPackage] ?? ''),
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

  /**
   * Stops packages nobody has called for a while, removes stopped ones and old workers, and drops
   * networks no container uses any more.
   */
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
            if (now - last < this.config.RUNNER_MCP_IDLE_STOP_MS || this.inFlight.has(packageId)) return;
            this.closeRelays(packageId, 'The server was stopped (idle)');
            await container.stop({ t: 5 });
            this.log.info('MCP package stopped (idle)', { packageId });
          }
          await container.remove({ force: true });
          await this.dropNetwork(packageId);
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
    const networks = await this.docker.listNetworks({
      filters: { label: [`${LABELS.runner}=${mcpLabel(this.config)}`] },
    });
    for (const network of networks) {
      const packageId = network.Labels?.[LABELS.mcpPackage];
      if (!packageId || !isTaskId(packageId)) continue;
      await this.locked(packageId, async () => {
        if ((await this.packageContainers(packageId)).length === 0) await this.dropNetwork(packageId);
      }).catch((error: unknown) =>
        this.log.warn('Dropping an MCP network failed', { packageId, error: dockerMessage(error) }),
      );
    }
  }

  // --- helpers ---

  /** Starts the server's process in its package's container and wires its stdio. */
  private async openServer(serverId: string, events: ChildEvents): Promise<Child> {
    const spec = this.launches.get(serverId);
    if (!spec)
      throw new RunnerError(409, 'launch_unknown', 'The runner does not know how to start this server');
    const container = await this.locked(spec.packageId, () => this.ensureContainer(spec));
    const pidFile = `/tmp/mcp-${serverId}-${randomUUID().slice(0, 8)}.pid`;
    let stream: Duplex;
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', WITH_PID_FILE, 'sh', pidFile, ...spec.command],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: SANDBOX_USER,
        WorkingDir: spec.cwd ?? PLUGIN_ROOT,
        // Secrets reach this process only, never the container's configuration.
        Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
      });
      stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    } catch (error) {
      // Its container went meanwhile (an uninstall, an idle stop): an answer, not a runner failure.
      this.requireLive(spec.packageId);
      if ((error as { statusCode?: number }).statusCode === 409 || isDockerNotFound(error)) {
        throw new RunnerError(503, 'mcp_unavailable', "The server's container stopped: try again");
      }
      throw error;
    }
    const out = new PassThrough();
    const err = new PassThrough();
    this.docker.modem.demuxStream(stream, out, err);
    let reason = 'The MCP server exited';
    let stopped = false;
    // Ending its input stops a well-behaved server; one that ignores it is stopped by its pid.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!stream.destroyed) {
        stream.end();
        stream.destroy();
      }
      void execIn(this.docker, container, {
        cmd: ['sh', '-c', STOP_BY_PID_FILE, 'sh', pidFile],
        user: SANDBOX_USER,
        maxOutputBytes: 4 * 1024,
        deadlineMs: 15_000,
      }).catch(() => {});
    };
    stream.on('end', () => {
      out.end();
      err.end();
    });
    stream.on('error', () => stream.destroy());
    out.on('error', () => {});
    err.on('error', () => {});
    stream.on('close', () => {
      stop();
      events.close(reason);
    });
    err.on('data', (chunk: Buffer) =>
      this.log.debug('MCP server stderr', { serverId, text: chunk.toString('utf8').slice(0, 500) }),
    );
    splitLines(
      out,
      MAX_LINE_BYTES,
      (line) => {
        try {
          events.line(line);
        } catch (error) {
          this.log.warn('An MCP server message could not be handled', { serverId, error: String(error) });
        }
      },
      () => {
        reason = 'The MCP server wrote a message larger than 8 MiB, so it was stopped';
        this.log.warn('An MCP server wrote too much in one message: stopped', { serverId });
        stop();
      },
    );
    return {
      write: (text) => {
        if (!stream.destroyed) stream.write(text);
      },
      close: stop,
    };
  }

  private async ensureContainer(spec: McpLaunch): Promise<Docker.Container> {
    this.requireLive(spec.packageId);
    const name = mcpName(this.config, spec.packageId);
    let info = await this.inspect(name);
    // Started with another network setting: replaced.
    if (info && info.Config.Labels[LABELS.mcpNetwork] !== spec.network) {
      // Their processes go with the container; the relays stay (one of them is starting this one).
      this.stopRelays(spec.packageId, 'The package was restarted');
      await this.removeContainer(name);
      await this.dropNetwork(spec.packageId);
      info = undefined;
    }
    await this.requireReady(spec.network);
    // The proxy joins the package's network again if it was recreated meanwhile.
    if (spec.network === 'egress') await this.packageNetwork(spec.packageId);
    if (info?.State.Running) return this.docker.getContainer(name);
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

  /**
   * The package's own internal network, which the egress proxy joins under its proxy host name: the
   * package's servers reach the proxy and nothing else, other packages' containers included.
   */
  private async packageNetwork(packageId: string): Promise<string> {
    const name = mcpNetworkName(this.config, packageId);
    const network = this.docker.getNetwork(name);
    let info = await network.inspect().catch((error: unknown) => {
      if (isDockerNotFound(error)) return undefined;
      throw error;
    });
    if (!info) {
      await this.docker.createNetwork({
        Name: name,
        Internal: true,
        Labels: { [LABELS.runner]: mcpLabel(this.config), [LABELS.mcpPackage]: packageId },
      });
      info = await network.inspect();
    }
    const proxy = this.config.RUNNER_MCP_PROXY;
    if (!proxy) return name;
    const egress = await this.docker.listContainers({
      filters: { network: [this.config.RUNNER_MCP_NETWORK] },
    });
    // The proxy is what sits on the MCP network without being one of the runners' containers.
    const proxies = egress.filter((container) => !container.Labels[LABELS.runner]);
    if (proxies.length === 0) {
      throw new RunnerError(503, 'mcp_unavailable', 'The egress proxy is not running');
    }
    const attached = new Set(Object.keys(info.Containers ?? {}));
    for (const proxyContainer of proxies) {
      if (attached.has(proxyContainer.Id)) continue;
      await network.connect({
        Container: proxyContainer.Id,
        EndpointConfig: { Aliases: [new URL(proxy).hostname] },
      });
    }
    return name;
  }

  /** Removes the package's network, once nothing of the package uses it (the proxy leaves it first). */
  private async dropNetwork(packageId: string): Promise<void> {
    const network = this.docker.getNetwork(mcpNetworkName(this.config, packageId));
    try {
      const info = await network.inspect();
      for (const id of Object.keys(info.Containers ?? {})) {
        await network.disconnect({ Container: id, Force: true }).catch(() => {});
      }
      await network.remove();
    } catch (error) {
      if (!isDockerNotFound(error)) {
        this.log.warn('Removing an MCP network failed', { packageId, error: dockerMessage(error) });
      }
    }
  }

  /** At the running limit, stops the least recently used package nobody is calling, or refuses. */
  private async makeRoom(packageId: string): Promise<void> {
    const running = (await this.containers()).filter(
      (c) => c.State === 'running' && c.Labels[LABELS.mcpPackage] !== packageId,
    );
    if (running.length < this.config.RUNNER_MAX_MCP) return;
    const victim = running
      .map((c) => ({ id: c.Id, packageId: c.Labels[LABELS.mcpPackage] ?? '' }))
      .filter((c) => !this.inFlight.has(c.packageId))
      .sort((a, b) => (this.lastUsed.get(a.packageId) ?? 0) - (this.lastUsed.get(b.packageId) ?? 0))[0];
    if (!victim) throw new RunnerError(503, 'mcp_busy', 'Too many MCP packages are running');
    this.closeRelays(victim.packageId, 'The server was stopped to make room');
    await this.docker.getContainer(victim.id).stop({ t: 5 });
    this.log.info('MCP package stopped to make room', { packageId: victim.packageId, for: packageId });
  }

  private closeRelay(serverId: string, reason: string): void {
    this.relays.get(serverId)?.dispose(reason);
    this.relays.delete(serverId);
  }

  private closeRelays(packageId: string, reason: string): void {
    for (const [serverId, spec] of this.launches) {
      if (spec.packageId === packageId) this.closeRelay(serverId, reason);
    }
  }

  /** Ends the package's sessions (their processes stop); the relays start new ones on the next call. */
  private stopRelays(packageId: string, reason: string): void {
    for (const [serverId, spec] of this.launches) {
      if (spec.packageId === packageId) this.relays.get(serverId)?.close(reason);
    }
  }

  /** The package's volumes exist, and their folders belong to the sandbox user. */
  private async prepare(packageId: string): Promise<void> {
    await this.requireImage();
    const { opt, data } = mcpVolumes(this.config, packageId);
    const labels = { [LABELS.runner]: mcpLabel(this.config), [LABELS.mcpPackage]: packageId };
    await this.docker.createVolume({ Name: opt, Labels: labels });
    await this.docker.createVolume({ Name: data, Labels: labels });
    await this.worker(packageId, { asRoot: true, lifetimeMs: 120_000 }, async (container) => {
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
    options: { install?: boolean; asRoot?: boolean; lifetimeMs: number },
    work: (container: Docker.Container) => Promise<T>,
  ): Promise<T> {
    if (options.install) {
      await this.requireReady('egress');
      await this.packageNetwork(packageId);
    } else await this.requireImage();
    const container = await this.docker.createContainer(
      mcpWorkerSpec(this.config, {
        packageId,
        cmd: ['sleep', String(Math.ceil(options.lifetimeMs / 1000))],
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

  private async removeWorkers(packageId: string): Promise<void> {
    const workers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`${LABELS.runner}=${mcpLabel(this.config)}-worker`, `${LABELS.mcpPackage}=${packageId}`],
      },
    });
    for (const worker of workers) {
      await this.docker
        .getContainer(worker.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }

  private async run(
    container: Docker.Container,
    cmd: string[],
    deadline: number,
    workingDir?: string,
  ): Promise<{ ok: boolean; out: string; log: string }> {
    const outcome = await execIn(this.docker, container, {
      cmd,
      user: SANDBOX_USER,
      workingDir,
      maxOutputBytes: 2 * 1024 * 1024,
      deadlineMs: Math.max(1_000, deadline - Date.now()),
    });
    const out = outcome.stdout.toString('utf8');
    const log = `${out}${outcome.stderr.toString('utf8')}`.slice(-4000);
    return { ok: outcome.exitCode === 0 && !outcome.abandoned, out, log };
  }

  private async installNpm(
    container: Docker.Container,
    server: McpInstallInput['servers'][number],
    deadline: number,
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
      const step = await this.run(container, cmd, deadline, cwd);
      log = step.log;
      if (!step.ok) return fail(log);
    }
    const resolved = await this.run(
      container,
      ['node', '-e', NPM_RESOLVE, dir, server.package, server.bin ?? ''],
      deadline,
    );
    let answer: { executable?: string; version?: string; error?: string };
    try {
      answer = JSON.parse(resolved.out.trim() || '{}') as typeof answer;
    } catch {
      return fail(resolved.log);
    }
    if (!answer.executable) return fail(answer.error ?? resolved.log);
    const lock = await this.run(container, ['cat', `${dir}/package-lock.json`], deadline);
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
    deadline: number,
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
      const step = await this.run(container, cmd, deadline);
      log = step.log;
      if (!step.ok) return fail(log);
    }
    const freeze = await this.run(container, ['uv', 'pip', 'freeze', '--python', python], deadline);
    const executable = `${dir}/venv/bin/${server.bin ?? server.package}`;
    const exists = await this.run(container, ['test', '-x', executable], deadline);
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

  /** The image, and the network the egress proxy joins when the work needs one. */
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

  /** The package's container and its workers. */
  private packageContainers(packageId: string): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.mcpPackage}=${packageId}`] },
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

  /** A package that exists, or may: one removed (uninstalled) never comes back. */
  private requireLive(packageId: string): void {
    this.requireId(packageId);
    if (this.removed.has(packageId)) {
      throw new RunnerError(410, 'package_removed', 'This package was removed');
    }
  }
}
