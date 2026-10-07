import { describe, expect, it } from 'vitest';
import { loadBrowserSeccomp } from '../src/browsers';
import { RunnerConfigSchema } from '../src/config';
import { TailBuffer } from '../src/docker';
import {
  browserSpec,
  containerName,
  helperSpec,
  identityVolume,
  isTaskId,
  sandboxSpec,
  taskSubpath,
} from '../src/policy';

const TASK = '01900000-0000-7000-8000-0000000000aa';
const config = RunnerConfigSchema.parse({ RUNNER_TOKEN: 'x'.repeat(32) });

describe('sandbox policy', () => {
  it('hardens every sandbox and mounts only the task folder', () => {
    const spec = sandboxSpec(config, { taskId: TASK, profile: 'dev', image: 'superagent-sandbox-dev:1' });
    expect(spec.name).toBe(`sa-task-${TASK}`);
    expect(spec.User).toBe('1000:1000');
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      PidsLimit: 256,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
    });
    expect(spec.HostConfig?.Mounts).toEqual([
      {
        Type: 'volume',
        Source: 'superagent-workspaces',
        Target: '/workspace',
        VolumeOptions: { NoCopy: true, Subpath: `tasks/${TASK}` },
      },
    ]);
    expect(spec.HostConfig?.Binds).toBeUndefined();
    expect(spec.HostConfig?.CapAdd).toBeUndefined();
    // One file can't fill the disk.
    expect(spec.HostConfig?.Ulimits).toEqual([
      { Name: 'fsize', Soft: 2048 * 1024 * 1024, Hard: 2048 * 1024 * 1024 },
    ]);
  });

  it('lets only the volume preparation run as root, with nothing but CHOWN', () => {
    const prepare = helperSpec(config, {
      image: 'img',
      cmd: ['true'],
      mount: { readOnly: false },
      asRoot: true,
    });
    expect(prepare.User).toBe('0:0');
    expect(prepare.HostConfig?.CapAdd).toEqual(['CHOWN']);
    const reader = helperSpec(config, {
      image: 'img',
      cmd: ['true'],
      mount: { taskId: TASK, readOnly: true },
    });
    expect(reader.User).toBe('1000:1000');
    expect(reader.HostConfig?.Mounts?.[0]).toMatchObject({
      ReadOnly: true,
      VolumeOptions: { Subpath: `tasks/${TASK}` },
    });
  });

  it('accepts only UUID task ids', () => {
    expect(isTaskId(TASK)).toBe(true);
    for (const bad of ['../etc', 'tasks/x', `${TASK}/..`, TASK.toUpperCase(), '']) {
      expect(isTaskId(bad)).toBe(false);
    }
    expect(() => taskSubpath('../../x')).toThrow();
    expect(containerName(config, TASK)).toBe(`sa-task-${TASK}`);
  });

  it('reads the image allowlist as JSON', () => {
    expect(config.RUNNER_IMAGES).toEqual({ dev: 'superagent-sandbox-dev:1' });
    expect(() =>
      RunnerConfigSchema.parse({ RUNNER_TOKEN: 'x'.repeat(32), RUNNER_IMAGES: '{"dev":"bad image"}' }),
    ).toThrow();
    expect(() => RunnerConfigSchema.parse({ RUNNER_TOKEN: 'short' })).toThrow();
    // The example value from .env.example is public: never accepted.
    expect(() =>
      RunnerConfigSchema.parse({ RUNNER_TOKEN: 'change-me-runner-token-at-least-32-characters' }),
    ).toThrow();
  });
});

describe('output tail', () => {
  it('keeps the last bytes and says it dropped some', () => {
    const tail = new TailBuffer(5);
    tail.push(Buffer.from('abc'));
    tail.push(Buffer.from('defg'));
    expect(tail.value().toString()).toBe('cdefg');
    expect(tail.truncated).toBe(true);
    const small = new TailBuffer(10);
    small.push(Buffer.from('hi'));
    expect(small.truncated).toBe(false);
  });
});

describe('browser policy', () => {
  const IDENTITY = '01900000-0000-7000-8000-0000000000bb';
  const seccomp = loadBrowserSeccomp('auto') as string;

  it('runs Chromium hardened, on the browsers network, with its own sandbox', () => {
    const spec = browserSpec(config, { taskId: TASK, seccomp });
    expect(spec.name).toBe(`sa-task-browser-${TASK}`);
    expect(spec.User).toBe('1000:1000');
    expect(spec.StopSignal).toBe('SIGINT');
    expect(spec.Env).toEqual(['BROWSER_PROXY=http://egress:3128', 'BROWSER_BYPASS=']);
    expect(spec.Labels).toEqual({ 'superagent.runner': 'sa-task-browser', 'superagent.task': TASK });
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'superagent-browsers',
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      Privileged: false,
      PidsLimit: 1024,
      Memory: 2048 * 1024 * 1024,
      MemorySwap: 2048 * 1024 * 1024,
    });
    expect(spec.HostConfig?.SecurityOpt).toEqual(['no-new-privileges:true', `seccomp=${seccomp}`]);
    expect(spec.HostConfig?.CapAdd).toBeUndefined();
    expect(spec.HostConfig?.PortBindings).toBeUndefined();
    // No identity: a throwaway profile.
    expect(spec.HostConfig?.Mounts).toEqual([]);
    expect(spec.HostConfig?.Tmpfs?.['/profile']).toContain('uid=1000');
  });

  it('allows only the namespace calls Chromium sandboxes its renderers with', () => {
    const profile = JSON.parse(seccomp) as {
      defaultAction: string;
      syscalls: Array<{ names: string[]; action: string; comment?: string }>;
    };
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    const added = profile.syscalls.filter((rule) => rule.comment?.startsWith('superagent'));
    expect(added).toHaveLength(1);
    expect(added[0]?.names.sort()).toEqual(['chroot', 'clone', 'setns', 'unshare']);
    expect(added[0]?.action).toBe('SCMP_ACT_ALLOW');
  });

  it("mounts an identity's profile volume, and runs unsandboxed only when told", () => {
    const spec = browserSpec(config, { taskId: TASK, identityId: IDENTITY });
    expect(spec.Labels?.['superagent.identity']).toBe(IDENTITY);
    expect(spec.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: `superagent-identity-${IDENTITY}`, Target: '/profile' },
    ]);
    expect(spec.HostConfig?.Tmpfs?.['/profile']).toBeUndefined();
    expect(spec.Env).toContain('BROWSER_SANDBOX=no');
    expect(spec.HostConfig?.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(loadBrowserSeccomp('none')).toBeUndefined();
    expect(() => identityVolume(config, '../x')).toThrow();
  });
});
