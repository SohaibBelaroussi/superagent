import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { DaemonLimits, limitedDocker } from '../src/limits';

/** Just enough of Docker: its info, and a record of the containers created. */
function fakeDocker(info: Record<string, boolean>) {
  const created: unknown[] = [];
  const docker = {
    info: async () => info,
    createContainer: async (options: unknown) => {
      created.push(options);
      return { id: 'c1' };
    },
    modem: { name: 'modem' },
  } as unknown as Docker;
  return { docker, created };
}

describe('container limits', () => {
  it('creates containers where the daemon enforces memory, CPU and process limits', async () => {
    const { docker, created } = fakeDocker({ MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true });
    const limits = new DaemonLimits(docker);
    await limitedDocker(docker, limits).createContainer({ Image: 'x' });
    expect(created).toHaveLength(1);
    expect(await limits.enforced()).toBe(true);
    // Everything else is the daemon's own.
    expect((limitedDocker(docker, limits) as unknown as { modem: unknown }).modem).toEqual({ name: 'modem' });
  });

  it('refuses them where it would ignore the limits (rootless Docker without cgroup delegation)', async () => {
    const { docker, created } = fakeDocker({ MemoryLimit: false, CpuCfsQuota: false, PidsLimit: true });
    const limits = new DaemonLimits(docker);
    await expect(limitedDocker(docker, limits).createContainer({ Image: 'x' })).rejects.toMatchObject({
      status: 503,
      code: 'limits_unsupported',
      message: expect.stringContaining('memory, CPU'),
    });
    expect(created).toHaveLength(0);
    expect(await limits.enforced()).toBe(false);
    // Unless told otherwise (never on a server).
    const anyway = new DaemonLimits(docker, true);
    await limitedDocker(docker, anyway).createContainer({ Image: 'x' });
    expect(created).toHaveLength(1);
  });
});
