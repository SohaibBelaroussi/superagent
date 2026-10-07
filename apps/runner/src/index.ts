import Docker from 'dockerode';
import type { Hono } from 'hono';
import { createRunnerApp } from './app';
import type { RunnerConfig } from './config';
import { dockerMessage } from './docker';
import { type Logger, SandboxManager } from './sandboxes';

export { loadRunnerConfig, type RunnerConfig, RunnerConfigError, RunnerConfigSchema } from './config';
export { type Logger, RunnerError, SandboxManager } from './sandboxes';

export interface Runner {
  app: Hono;
  manager: SandboxManager;
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

/** The runner: its HTTP app and the sandbox manager behind it. Docker comes from DOCKER_HOST or the default socket. */
export function createRunner(
  config: RunnerConfig,
  options: { docker?: Docker; logger?: Logger } = {},
): Runner {
  const logger = options.logger ?? consoleLogger(config.LOG_LEVEL);
  const docker = options.docker ?? new Docker();
  const manager = new SandboxManager(docker, config, logger);
  const app = createRunnerApp(manager, config, logger);
  let timer: NodeJS.Timeout | undefined;
  let reaping: Promise<void> | undefined;
  return {
    app,
    manager,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // One pass at a time: a slow pass (Docker busy) is not overlapped by the next.
        if (reaping) return;
        reaping = manager
          .reap()
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
