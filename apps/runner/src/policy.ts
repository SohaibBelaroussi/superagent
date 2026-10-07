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
  identity: 'superagent.identity',
  mcpPackage: 'superagent.mcp.package',
  mcpNetwork: 'superagent.mcp.network',
} as const;
/** Where an identity's profile (cookies, storage) is mounted in its browser. */
export const PROFILE_DIR = '/profile';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export function containerName(config: RunnerConfig, taskId: string): string {
  return `${config.RUNNER_NAME_PREFIX}-${taskId}`;
}

export function browserName(config: RunnerConfig, taskId: string): string {
  return `${config.RUNNER_NAME_PREFIX}-browser-${taskId}`;
}

/** Browsers carry their own runner label, so sandbox and browser listings never mix. */
export function browserLabel(config: RunnerConfig): string {
  return `${config.RUNNER_NAME_PREFIX}-browser`;
}

export function identityVolume(config: RunnerConfig, identityId: string): string {
  if (!isTaskId(identityId)) throw new Error(`Not an identity id: ${identityId}`);
  return `${config.RUNNER_IDENTITY_VOLUME_PREFIX}-${identityId}`;
}

/**
 * A task's browser (decision D34): Chromium as the sandbox user with no capabilities and a read-only
 * root, on the browsers network (internal: its only way out is the egress proxy), DevTools on loopback
 * only. With an identity, its profile volume holds the logged-in state; without one, a throwaway tmpfs.
 * The seccomp profile lets Chromium build its own renderer sandbox; without it, Chromium runs unsandboxed.
 */
export function browserSpec(
  config: RunnerConfig,
  input: { taskId: string; identityId?: string; seccomp?: string },
): Docker.ContainerCreateOptions {
  const memory = config.RUNNER_BROWSER_MEMORY_MB * 1024 * 1024;
  return {
    name: browserName(config, input.taskId),
    Image: config.RUNNER_BROWSER_IMAGE,
    User: SANDBOX_USER,
    Env: [
      `BROWSER_PROXY=${config.RUNNER_BROWSER_PROXY}`,
      `BROWSER_BYPASS=${config.RUNNER_BROWSER_BYPASS}`,
      ...(input.seccomp ? [] : ['BROWSER_SANDBOX=no']),
    ],
    Labels: {
      [LABELS.runner]: browserLabel(config),
      [LABELS.task]: input.taskId,
      ...(input.identityId ? { [LABELS.identity]: input.identityId } : {}),
    },
    // Chromium saves cookies and drops its profile lock on SIGINT; SIGTERM loses both.
    StopSignal: 'SIGINT',
    HostConfig: {
      NetworkMode: config.RUNNER_BROWSER_NETWORK,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true', ...(input.seccomp ? [`seccomp=${input.seccomp}`] : [])],
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=1024m',
        ...(input.identityId ? {} : { [PROFILE_DIR]: 'rw,nosuid,nodev,size=512m,uid=1000,gid=1000' }),
      },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: 2e9,
      PidsLimit: config.RUNNER_BROWSER_PIDS_LIMIT,
      Init: true,
      Privileged: false,
      // The image's /profile is owned by the sandbox user: a fresh identity volume takes that owner.
      Mounts: input.identityId
        ? [{ Type: 'volume', Source: identityVolume(config, input.identityId), Target: PROFILE_DIR }]
        : [],
    },
  };
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
      // No single file bigger than this (a sandbox can't fill the disk with one fallocate).
      Ulimits: [
        {
          Name: 'fsize',
          Soft: config.RUNNER_FILE_LIMIT_MB * 1024 * 1024,
          Hard: config.RUNNER_FILE_LIMIT_MB * 1024 * 1024,
        },
      ],
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

/** Where a plugin's files are mounted in its MCP container, read-only (`${PLUGIN_ROOT}`). */
export const PLUGIN_ROOT = '/opt/plugin';
/** Its servers' own writable folder (`${PLUGIN_DATA}`), kept until the plugin is uninstalled. */
export const PLUGIN_DATA = '/data';

export function mcpName(config: RunnerConfig, packageId: string): string {
  return `${config.RUNNER_NAME_PREFIX}-mcp-${packageId}`;
}

/** A package's own internal network: its containers and the egress proxy, nothing else. */
export function mcpNetworkName(config: RunnerConfig, packageId: string): string {
  return `${mcpName(config, packageId)}-net`;
}

/** MCP containers carry their own runner label, like browsers. */
export function mcpLabel(config: RunnerConfig): string {
  return `${config.RUNNER_NAME_PREFIX}-mcp`;
}

/** A package's volumes: its files and installs (mounted at /opt), and its servers' data. */
export function mcpVolumes(config: RunnerConfig, packageId: string): { opt: string; data: string } {
  if (!isTaskId(packageId)) throw new Error(`Not a package id: ${packageId}`);
  return {
    opt: `${config.RUNNER_MCP_VOLUME_PREFIX}-${packageId}`,
    data: `${config.RUNNER_MCP_VOLUME_PREFIX}-data-${packageId}`,
  };
}

/** Proxy settings most runtimes read (Node's fetch with NODE_USE_ENV_PROXY, npm, uv, Python, curl). */
export function proxyEnv(proxy: string): string[] {
  if (!proxy) return [];
  return [
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    'NO_PROXY=',
    'no_proxy=',
    'NODE_USE_ENV_PROXY=1',
  ];
}

const NO_COPY = { NoCopy: true } as Docker.MountSettings['VolumeOptions'];

const MCP_ENV = [
  'HOME=/tmp',
  'LANG=C.UTF-8',
  `PLUGIN_ROOT=${PLUGIN_ROOT}`,
  `PLUGIN_DATA=${PLUGIN_DATA}`,
  `CLAUDE_PLUGIN_ROOT=${PLUGIN_ROOT}`,
  `CLAUDE_PLUGIN_DATA=${PLUGIN_DATA}`,
  'PYTHONDONTWRITEBYTECODE=1',
  'UV_PYTHON_DOWNLOADS=never',
  'UV_CACHE_DIR=/tmp/uv',
  'npm_config_cache=/tmp/.npm',
  'npm_config_update_notifier=false',
];

function mcpMounts(config: RunnerConfig, packageId: string, readOnlyOpt: boolean): Docker.MountSettings[] {
  const volumes = mcpVolumes(config, packageId);
  // NoCopy: Docker would otherwise copy the image's folder in and hand the volume to root.
  return [
    { Type: 'volume', Source: volumes.opt, Target: '/opt', ReadOnly: readOnlyOpt, VolumeOptions: NO_COPY },
    { Type: 'volume', Source: volumes.data, Target: PLUGIN_DATA, VolumeOptions: NO_COPY },
  ];
}

/**
 * A package's MCP container (decision D36): third-party servers as the sandbox user, no capabilities,
 * a read-only root and package files, limits; on the package's own network (internal: its only way out
 * is the egress proxy, and other packages can't be reached) or no network. It only sleeps: the runner
 * execs each server and relays its stdio.
 */
export function mcpSpec(
  config: RunnerConfig,
  input: { packageId: string; network: 'egress' | 'none' },
): Docker.ContainerCreateOptions {
  const memory = config.RUNNER_MCP_MEMORY_MB * 1024 * 1024;
  const egress = input.network === 'egress';
  return {
    name: mcpName(config, input.packageId),
    Image: config.RUNNER_MCP_IMAGE,
    Cmd: ['sleep', 'infinity'],
    User: SANDBOX_USER,
    WorkingDir: PLUGIN_ROOT,
    Env: [...MCP_ENV, ...(egress ? proxyEnv(config.RUNNER_MCP_PROXY) : [])],
    Labels: {
      [LABELS.runner]: mcpLabel(config),
      [LABELS.mcpPackage]: input.packageId,
      [LABELS.mcpNetwork]: input.network,
    },
    NetworkDisabled: !egress,
    HostConfig: {
      NetworkMode: egress ? mcpNetworkName(config, input.packageId) : 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: 1e9,
      PidsLimit: config.RUNNER_MCP_PIDS_LIMIT,
      Init: true,
      Privileged: false,
      Ulimits: [
        {
          Name: 'fsize',
          Soft: config.RUNNER_FILE_LIMIT_MB * 1024 * 1024,
          Hard: config.RUNNER_FILE_LIMIT_MB * 1024 * 1024,
        },
      ],
      Mounts: mcpMounts(config, input.packageId, true),
    },
  };
}

/**
 * A short-lived worker on a package's volumes: preparing them (root, with CHOWN only), writing the
 * plugin's files (no network), or installing its packages (through the egress proxy, scripts off).
 */
export function mcpWorkerSpec(
  config: RunnerConfig,
  input: { packageId: string; cmd: string[]; asRoot?: boolean; install?: boolean },
): Docker.ContainerCreateOptions {
  const install = Boolean(input.install);
  const memory = (install ? 1024 : 256) * 1024 * 1024;
  return {
    Image: config.RUNNER_MCP_IMAGE,
    Cmd: input.cmd,
    User: input.asRoot ? '0:0' : SANDBOX_USER,
    WorkingDir: '/tmp',
    Env: [...MCP_ENV, ...(install ? proxyEnv(config.RUNNER_MCP_PROXY) : [])],
    Labels: { [LABELS.runner]: `${mcpLabel(config)}-worker`, [LABELS.mcpPackage]: input.packageId },
    NetworkDisabled: !install,
    HostConfig: {
      NetworkMode: install ? mcpNetworkName(config, input.packageId) : 'none',
      CapDrop: ['ALL'],
      CapAdd: input.asRoot ? ['CHOWN'] : [],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${install ? 1024 : 64}m` },
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: install ? 512 : 64,
      Init: true,
      Privileged: false,
      Mounts: mcpMounts(config, input.packageId, false),
    },
  };
}
