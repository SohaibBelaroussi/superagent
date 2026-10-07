import type { Server } from 'node:http';
import Docker from 'dockerode';
import type { Hono } from 'hono';
import { createRunnerApp } from './app';
import { BrowserContainers } from './browsers';
import type { RunnerConfig } from './config';
import { dockerMessage } from './docker';
import { type Logger, SandboxManager } from './sandboxes';

export { BrowserContainers, loadBrowserSeccomp } from './browsers';
export { loadRunnerConfig, type RunnerConfig, RunnerConfigError, RunnerConfigSchema } from './config';
export { type Logger, RunnerError, SandboxManager } from './sandboxes';

export interface Runner {
  app: Hono;
  manager: SandboxManager;
  browsers: BrowserContainers;
  /** Serves browsers' DevTools connections (WebSocket upgrades) on the runner's HTTP server. */
  attach(server: Pick<Server, 'on'>): void;
  /** Starts the reaper. */
  start(): void;
  stop(): void;
}

/** Console JSON logs, one line each. */
export function consoleLogger(level: RunnerConfig['LOG_LEVEL'] = 'info'): Logger {
  const order = ['debug', 'info', 'warn', 'error'] as const;
  const enabled = (at: (typeof order)[number]) => order.indexOf(at) >= order.indexOf(level);
  const write = (at: (typeof order)[number]) => (message: string, data?: Record<string, unknown>) => {
    if (!enabled(at)) return;
    const line = JSON.stringify({ level: at, time: new Date().toISOString(), msg: message, ...data });
    (at === 'error' || at === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** The runner: its HTTP app, sandboxes and browsers. Docker comes from DOCKER_HOST or the default socket. */
export function createRunner(
  config: RunnerConfig,
  options: { docker?: Docker; logger?: Logger } = {},
): Runner {
  const logger = options.logger ?? consoleLogger(config.LOG_LEVEL);
  const docker = options.docker ?? new Docker();
  const manager = new SandboxManager(docker, config, logger);
  const browsers = new BrowserContainers(docker, config, logger);
  const app = createRunnerApp(manager, browsers, config, logger);
  let timer: NodeJS.Timeout | undefined;
  let reaping: Promise<void> | undefined;
  return {
    app,
    manager,
    browsers,
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy());
        if (browsers.handles(req)) {
          browsers.relay(req, socket, head).catch((error: unknown) => {
            logger.warn('A DevTools relay failed', { error: dockerMessage(error) });
            socket.destroy();
          });
          return;
        }
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // One pass at a time: a slow pass (Docker busy) is not overlapped by the next.
        if (reaping) return;
        const pass = async () => {
          await manager.reap();
          await browsers.reap();
        };
        reaping = pass()
          .catch((error: unknown) => logger.warn('Reaper failed', { error: dockerMessage(error) }))
          .finally(() => {
            reaping = undefined;
          });
      }, config.RUNNER_REAP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
