import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from '../src/config';
import { splitLines } from '../src/mcp';
import { mcpNetworkName, mcpSpec, mcpWorkerSpec } from '../src/policy';

const PACKAGE = '01900000-0000-7000-8000-0000000000bb';
const config = RunnerConfigSchema.parse({ RUNNER_TOKEN: 'x'.repeat(32) });

describe('MCP policy', () => {
  it("puts each package on its own network (the egress proxy's only), or on none", () => {
    const network = mcpNetworkName(config, PACKAGE);
    expect(network).toBe(`${config.RUNNER_NAME_PREFIX}-mcp-${PACKAGE}-net`);
    expect(mcpSpec(config, { packageId: PACKAGE, network: 'egress' }).HostConfig?.NetworkMode).toBe(network);
    const offline = mcpSpec(config, { packageId: PACKAGE, network: 'none' });
    expect(offline).toMatchObject({ NetworkDisabled: true, HostConfig: { NetworkMode: 'none' } });
    const install = mcpWorkerSpec(config, { packageId: PACKAGE, cmd: ['sleep', '1'], install: true });
    expect(install.HostConfig?.NetworkMode).toBe(network);
    expect(mcpWorkerSpec(config, { packageId: PACKAGE, cmd: ['sleep', '1'] }).HostConfig?.NetworkMode).toBe(
      'none',
    );
  });

  it('keeps installs under what the API waits for', () => {
    expect(config.RUNNER_MCP_INSTALL_TIMEOUT_MS).toBeLessThan(300_000);
    expect(() =>
      RunnerConfigSchema.parse({ RUNNER_TOKEN: 'x'.repeat(32), RUNNER_MCP_INSTALL_TIMEOUT_MS: '600000' }),
    ).toThrow();
  });
});

describe('MCP relay lines', () => {
  it('splits lines across chunks, drops CRs, and stops at a line that is too long', async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let overflows = 0;
    splitLines(
      input,
      16,
      (line) => lines.push(line),
      () => {
        overflows += 1;
      },
    );
    input.write('{"a":1}\r\n{"b"');
    input.write(':2}\n\n');
    input.write('x'.repeat(10));
    input.write('y'.repeat(10));
    input.write('\n{"c":3}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '']);
    expect(overflows).toBe(1);
  });
});
