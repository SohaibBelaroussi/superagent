import type Docker from 'dockerode';
import type { RunnerConfig } from './config';

/** The sandbox user (node in the Node images): never root. */
export const SANDBOX_USER = '1000:1000';
/** Where a task's folder is mounted in its sandbox. */
export const WORKSPACE_DIR = '/workspace';
export const LABELS = {
  runner: 'superagent.runner',
  task: 'superagent.task',
  profile: 'superagent.profile',
} as const;

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export function containerName(config: RunnerConfig, taskId: string): string {
  return `${config.RUNNER_NAME_PREFIX}-${taskId}`;
}

/** The folder of a task inside the workspaces volume. */
export function taskSubpath(taskId: string): string {
  if (!isTaskId(taskId)) throw new Error(`Not a task id: ${taskId}`);
  return `tasks/${taskId}`;
}

/**
 * A task's sandbox (decision D10): the task's folder only, as a non-root user with no capabilities, a
 * read-only root, a private /tmp, no network at all, and limits on memory, CPU and processes.
 */
export function sandboxSpec(
  config: RunnerConfig,
  input: { taskId: string; profile: string; image: string },
): Docker.ContainerCreateOptions {
  const memory = config.RUNNER_MEMORY_MB * 1024 * 1024;
  return {
    name: containerName(config, input.taskId),
    Image: input.image,
    Cmd: ['sleep', 'infinity'],
    User: SANDBOX_USER,
    WorkingDir: WORKSPACE_DIR,
    Env: ['HOME=/tmp', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'NPM_CONFIG_CACHE=/tmp/.npm'],
    Labels: {
      [LABELS.runner]: config.RUNNER_NAME_PREFIX,
      [LABELS.task]: input.taskId,
      [LABELS.profile]: input.profile,
    },
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${config.RUNNER_TMP_MB}m` },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(config.RUNNER_CPUS * 1e9),
      PidsLimit: config.RUNNER_PIDS_LIMIT,
      Init: true,
      Privileged: false,
      // NoCopy: Docker would otherwise copy the image's /workspace into an empty folder, as root.
      Mounts: [
        {
          Type: 'volume',
          Source: config.RUNNER_WORKSPACES_VOLUME,
          Target: WORKSPACE_DIR,
          VolumeOptions: {
            NoCopy: true,
            Subpath: taskSubpath(input.taskId),
          } as Docker.MountSettings['VolumeOptions'],
        },
      ],
    },
  };
}

/** A short-lived helper on the workspaces volume: same hardening, no network, removed after use. */
export function helperSpec(
  config: RunnerConfig,
  input: {
    image: string;
    cmd: string[];
    /** The whole volume (to make folders) or one task's folder, read-only (to read files). */
    mount: { taskId?: string; readOnly: boolean };
    asRoot?: boolean;
  },
): Docker.ContainerCreateOptions {
  return {
    Image: input.image,
    Cmd: input.cmd,
    User: input.asRoot ? '0:0' : SANDBOX_USER,
    WorkingDir: input.mount.taskId ? WORKSPACE_DIR : '/',
    Labels: { [LABELS.runner]: `${config.RUNNER_NAME_PREFIX}-helper` },
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      // Only to hand the tasks folder to the sandbox user, once.
      CapAdd: input.asRoot ? ['CHOWN'] : [],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Memory: 256 * 1024 * 1024,
      PidsLimit: 64,
      Mounts: [
        {
          Type: 'volume',
          Source: config.RUNNER_WORKSPACES_VOLUME,
          Target: input.mount.taskId ? WORKSPACE_DIR : '/w',
          ReadOnly: input.mount.readOnly,
          VolumeOptions: (input.mount.taskId
            ? { NoCopy: true, Subpath: taskSubpath(input.mount.taskId) }
            : { NoCopy: true }) as Docker.MountSettings['VolumeOptions'],
        },
      ],
    },
  };
}
