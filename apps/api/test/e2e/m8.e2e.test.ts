// M8 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`), with GitHub
// reachable: real plugins, pinned to commits. HyperFrames is skills only; the Agent Plugins conformance
// fixture has bundled stdio servers, which run in their own container, on a network of their own that
// only the egress proxy joins. Agents calling MCP tools and using skills are covered by the integration
// and live suites (they need a model).
import { execFileSync } from 'node:child_process';
import type { Capabilities, Department, McpServer, Plugin, PluginPreview } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const headers = {
  Authorization: `Bearer ${process.env.SUPERAGENT_ADMIN_TOKEN ?? ''}`,
  'content-type': 'application/json',
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const HYPERFRAMES_SHA = '5c7f6316d3646477a0f725176c00335cb8575560';
const CONFORMANCE_SHA = '6bfce5436435ffed10ab0020ee0f331ddeb640d6';

async function install(
  source: unknown,
  options: Record<string, unknown> = {},
): Promise<{ preview: PluginPreview; plugin: Plugin }> {
  const previewed = await call('POST', '/v1/plugins/preview', { source });
  expect(previewed.status, await previewed.clone().text()).toBe(200);
  const preview = (await previewed.json()) as PluginPreview;
  const installed = await call('POST', '/v1/plugins', { previewId: preview.id, ...options });
  expect(installed.status, await installed.clone().text()).toBe(201);
  let plugin = (await installed.json()) as Plugin;
  const deadline = Date.now() + 120_000;
  while (plugin.status === 'installing' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    plugin = (await (await call('GET', `/v1/plugins/${plugin.id}`)).json()) as Plugin;
  }
  return { preview, plugin };
}

describe(`M8 against ${BASE_URL}`, () => {
  it('installs HyperFrames from GitHub, pinned, and attaches its skills to a department', async () => {
    const { preview, plugin } = await install({
      kind: 'github',
      repo: 'heygen-com/hyperframes',
      ref: 'v0.8.140',
    });
    expect(preview).toMatchObject({
      format: 'agent-plugins',
      name: 'hyperframes',
      sha: HYPERFRAMES_SHA,
      mcpServers: [],
    });
    expect(preview.skills.length).toBe(21);
    expect(plugin).toMatchObject({ status: 'installed', name: 'hyperframes', sha: HYPERFRAMES_SHA });

    const marker = `e2e-${Date.now().toString(36)}`;
    const department = (await (
      await call('POST', '/v1/departments', {
        slug: marker,
        name: `Video ${marker}`,
        skills: ['hyperframes'],
      })
    ).json()) as Department;
    expect(department.skills).toEqual(['hyperframes']);
    const capabilities = (await (await call('GET', '/v1/capabilities')).json()) as Capabilities;
    expect(capabilities.skills.filter((s) => s.plugin === 'hyperframes').length).toBe(21);

    expect((await call('DELETE', `/v1/plugins/${plugin.id}`)).status).toBe(204);
    const after = (await (await call('GET', `/v1/departments/${department.id}`)).json()) as Department;
    expect(after.skills).toEqual([]);
    const left = (await (await call('GET', '/v1/capabilities')).json()) as Capabilities;
    expect(left.skills.some((s) => s.plugin === 'hyperframes')).toBe(false);
  }, 240_000);

  it("runs a plugin's bundled stdio servers in its own container, and uninstalls it cleanly", async () => {
    const { preview, plugin } = await install(
      {
        kind: 'github',
        repo: 'agentplugins/agent-plugins-conformance',
        path: 'plugins/agent-plugins-conformance-core',
        ref: CONFORMANCE_SHA,
      },
      { network: 'egress' },
    );
    expect(preview.format).toBe('agent-plugins');
    expect(preview.mcpServers.some((s) => s.key === 'default' && s.transport === 'stdio')).toBe(true);
    // Its loopback HTTP and SSE entries are skipped, not fatal.
    expect(preview.skipped.length).toBeGreaterThan(0);
    expect(plugin.status, plugin.statusDetail ?? '').not.toBe('installing');

    const servers = (
      (await (await call('GET', '/v1/mcp-servers')).json()) as { items: McpServer[] }
    ).items.filter((server) => server.plugin === plugin.name);
    const probe = servers.find((server) => server.slug.endsWith('-default'));
    // Its tools were listed through its container: the server ran there.
    expect(probe, JSON.stringify(servers.map((s) => [s.slug, s.status, s.statusDetail]))).toMatchObject({
      status: 'ready',
      transport: 'stdio',
    });
    expect(probe?.tools.map((tool) => tool.name)).toContain('observe');
    // Its container's network has the container and the egress proxy, nothing else.
    const network = docker('network', 'ls', '--format', '{{.Name}}', '--filter', `name=${plugin.id}`);
    expect(network).toMatch(new RegExp(`-mcp-${plugin.id}-net$`));
    const members = docker(
      'network',
      'inspect',
      network,
      '--format',
      '{{range .Containers}}{{.Name}} {{end}}',
    );
    expect(members.split(' ')).toHaveLength(2);
    expect(members.split(' ')).toEqual(
      expect.arrayContaining([expect.stringContaining('egress'), expect.stringContaining(plugin.id)]),
    );

    expect((await call('DELETE', `/v1/plugins/${plugin.id}`)).status).toBe(204);
    const remaining = ((await (await call('GET', '/v1/mcp-servers')).json()) as { items: McpServer[] }).items;
    // By slug: a server left behind would have lost its plugin.
    const slugs = new Set(plugin.mcpServers);
    expect(slugs.size).toBeGreaterThan(0);
    expect(remaining.filter((server) => slugs.has(server.slug))).toEqual([]);
    expect((await call('GET', `/v1/plugins/${plugin.id}`)).status).toBe(404);
    expect(docker('network', 'ls', '-q', '--filter', `name=${plugin.id}`)).toBe('');
    expect(docker('volume', 'ls', '-q', '--filter', `name=${plugin.id}`)).toBe('');
  }, 240_000);

  it('keeps secrets write-only and the capability routes behind the token', async () => {
    const name = `E2E_${Date.now().toString(36).toUpperCase()}`;
    expect((await call('PUT', `/v1/secrets/${name}`, { value: 'never-shown' })).status).toBe(200);
    expect(await (await call('GET', '/v1/secrets')).text()).not.toContain('never-shown');
    expect((await call('DELETE', `/v1/secrets/${name}`)).status).toBe(204);
    for (const path of ['/v1/capabilities', '/v1/secrets', '/v1/mcp-servers', '/v1/skills', '/v1/plugins']) {
      expect((await fetch(`${BASE_URL}${path}`)).status, path).toBe(401);
    }
  });
});
