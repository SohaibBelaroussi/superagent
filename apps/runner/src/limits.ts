import type Docker from 'dockerode';
import { RunnerError } from './sandboxes';

/**
 * Whether the daemon enforces the limits every container of ours relies on. Rootless Docker without
 * cgroup delegation accepts --memory, --cpus and --pids-limit and silently ignores them.
 */
export class DaemonLimits {
  private checked: Promise<string[]> | undefined;

  constructor(
    private readonly docker: Docker,
    private readonly allowNone = false,
  ) {}

  /** The limits the daemon would ignore (none: all good). Asked once, unless asking failed. */
  missing(): Promise<string[]> {
    this.checked ??= this.docker
      .info()
      .then((info: { MemoryLimit?: boolean; CpuCfsQuota?: boolean; PidsLimit?: boolean }) => [
        ...(info.MemoryLimit ? [] : ['memory']),
        ...(info.CpuCfsQuota ? [] : ['CPU']),
        ...(info.PidsLimit ? [] : ['process']),
      ])
      .catch((error: unknown) => {
        this.checked = undefined;
        throw error;
      });
    return this.checked;
  }

  async enforced(): Promise<boolean> {
    return (
      this.allowNone ||
      (await this.missing().then(
        (missing) => missing.length === 0,
        () => false,
      ))
    );
  }

  async require(): Promise<void> {
    if (this.allowNone) return;
    const missing = await this.missing();
    if (missing.length > 0) {
      throw new RunnerError(
        503,
        'limits_unsupported',
        `The Docker daemon ignores ${missing.join(', ')} limits (rootless Docker needs cgroup delegation): no container is created without them`,
      );
    }
  }
}

/**
 * The Docker client our services use: no container is created, or started again, where its limits
 * would be ignored.
 */
export function limitedDocker(docker: Docker, limits: DaemonLimits): Docker {
  return new Proxy(docker, {
    get(target, prop) {
      if (prop === 'createContainer') {
        return async (options: Docker.ContainerCreateOptions) => {
          await limits.require();
          return target.createContainer(options);
        };
      }
      if (prop === 'getContainer') {
        return (id: string) => limitedContainer(target.getContainer(id), limits);
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A container whose start (a stopped sandbox, browser or MCP package) waits for the limits check. */
function limitedContainer(container: Docker.Container, limits: DaemonLimits): Docker.Container {
  return new Proxy(container, {
    get(target, prop) {
      if (prop === 'start') {
        return async (...args: unknown[]) => {
          await limits.require();
          return (target.start as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
