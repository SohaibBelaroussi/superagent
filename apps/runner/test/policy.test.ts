import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from '../src/config';
import { TailBuffer } from '../src/docker';
import { containerName, helperSpec, isTaskId, sandboxSpec, taskSubpath } from '../src/policy';

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
