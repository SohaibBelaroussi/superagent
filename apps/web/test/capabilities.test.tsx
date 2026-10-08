import type { McpServer, Plugin, PluginPreview, Secret, Skill } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const AT = '2026-10-02T09:00:00.000Z';

const githubToken: Secret = {
  name: 'GITHUB_TOKEN',
  description: 'Read-only token',
  plugin: null,
  usedBy: ['github'],
  createdAt: AT,
  updatedAt: AT,
};
const spareKey: Secret = { ...githubToken, name: 'SPARE_KEY', description: '', usedBy: [] };

const github: McpServer = {
  id: '0199e000-0000-7000-8000-000000000001',
  slug: 'github',
  name: 'GitHub',
  description: 'Issues and pull requests.',
  plugin: null,
  transport: 'http',
  url: 'https://mcp.github.test/mcp',
  headers: { Authorization: { secret: 'GITHUB_TOKEN' } },
  allowPrivateNetwork: false,
  command: null,
  package: null,
  env: {},
  enabled: true,
  status: 'ready',
  statusDetail: null,
  tools: [
    { name: 'search_issues', key: 'github_search_issues', description: 'Search issues.' },
    { name: 'create_issue', key: 'github_create_issue', description: 'Open an issue.' },
  ],
  toolsRefreshedAt: AT,
  createdAt: AT,
  updatedAt: AT,
};
const wiki: McpServer = {
  ...github,
  id: '0199e000-0000-7000-8000-000000000002',
  slug: 'wiki',
  name: 'Wiki',
  url: 'http://10.0.0.9/mcp',
  headers: {},
  allowPrivateNetwork: true,
  status: 'failed',
  statusDetail: 'It can’t connect: connection refused',
  tools: [],
};

const researchKit: Plugin = {
  id: '0199f000-0000-7000-8000-000000000001',
  name: 'research-kit',
  title: 'Research kit',
  version: '1.2.0',
  description: 'Search and summarize.',
  format: 'agent-plugins',
  source: { kind: 'github', repo: 'acme/agent-plugins', path: 'plugins/research', ref: 'main' },
  sha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  license: 'MIT',
  status: 'installed',
  statusDetail: null,
  network: 'egress',
  skills: ['research-kit/deep-search', 'research-kit/summaries'],
  mcpServers: ['research-search'],
  warnings: [],
  createdAt: AT,
  updatedAt: AT,
};

const preview: PluginPreview = {
  id: '0199f000-0000-7000-8000-0000000000aa',
  expiresAt: '2026-10-08T12:00:00.000Z',
  source: { kind: 'github', repo: 'acme/agent-plugins', path: 'plugins/research', ref: 'HEAD' },
  sha: researchKit.sha,
  format: 'agent-plugins',
  name: 'research-kit',
  title: 'Research kit',
  version: '1.2.0',
  description: 'Search and summarize.',
  license: 'MIT',
  homepage: null,
  installed: false,
  skills: [
    { name: 'deep-search', description: 'Searches in depth.', files: 3, bytes: 4096 },
    { name: 'summaries', description: 'Summarizes long reads.', files: 1, bytes: 900 },
  ],
  mcpServers: [
    {
      key: 'search',
      slug: 'research-search',
      transport: 'stdio',
      command: null,
      package: 'npm:@acme/search-mcp@2.0.1',
      url: null,
      env: ['SEARCH_KEY'],
    },
  ],
  inputs: [
    {
      name: 'SEARCH_KEY',
      description: 'The search API key.',
      sensitive: true,
      required: true,
      default: null,
    },
    { name: 'REGION', description: 'Where to search.', sensitive: false, required: false, default: 'eu' },
  ],
  skipped: [],
  warnings: ['Its server runs code from npm.'],
  files: 6,
  bytes: 8192,
};

const deepSearch: Skill = {
  id: '0199f000-0000-7000-8000-0000000000b1',
  ref: 'research-kit/deep-search',
  plugin: 'research-kit',
  name: 'deep-search',
  description: 'Searches in depth.',
  license: 'MIT',
  compatibility: 'web_search',
  files: ['SKILL.md', 'scripts/rank.py', 'reference/sources.md'],
  bytes: 4096,
  createdAt: AT,
};

describe('secrets', () => {
  it('lists them by name only, and stores a new one sealed', async () => {
    const stored: Array<[string, unknown]> = [];
    server.use(
      http.get(api('/v1/secrets'), () => HttpResponse.json({ items: [githubToken] })),
      http.put(api('/v1/secrets/:name'), async ({ params, request }) => {
        stored.push([String(params.name), await request.json()]);
        return HttpResponse.json({ ...spareKey, name: String(params.name) });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/secrets');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Secrets' });
    expect(list).toHaveTextContent('GITHUB_TOKEN');
    expect(list).toHaveTextContent('Read-only token · Used by github');

    await user.click(screen.getByRole('button', { name: 'Add a secret' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a secret' });
    await user.type(within(dialog).getByLabelText('Name'), '1key');
    await user.click(within(dialog).getByRole('button', { name: 'Store secret' }));
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription(
      'Upper-case letters, digits and underscores, starting with a letter.',
    );
    expect(within(dialog).getByLabelText('Value')).toHaveAccessibleDescription('The value to store.');

    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'docs_key');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('DOCS_KEY');
    await user.type(within(dialog).getByLabelText('Value'), 'not-a-real-value');
    await user.type(within(dialog).getByLabelText('What it’s for'), 'The docs server');
    await user.click(within(dialog).getByRole('button', { name: 'Store secret' }));
    await waitFor(() =>
      expect(stored).toEqual([['DOCS_KEY', { value: 'not-a-real-value', description: 'The docs server' }]]),
    );
    expect(await screen.findByText('DOCS_KEY stored')).toBeVisible();
  });

  it('says who uses one before deleting it', async () => {
    const deleted: string[] = [];
    server.use(
      http.get(api('/v1/secrets'), () => HttpResponse.json({ items: [githubToken, spareKey] })),
      http.delete(api('/v1/secrets/:name'), ({ params }) => {
        deleted.push(String(params.name));
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/secrets');
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Secrets' });
    await user.click(screen.getByRole('button', { name: 'Delete GITHUB_TOKEN' }));
    expect(await screen.findByRole('dialog', { name: 'Delete GITHUB_TOKEN?' })).toHaveTextContent(
      'github use it: remove it from them first.',
    );
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    await user.click(screen.getByRole('button', { name: 'Delete SPARE_KEY' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete SPARE_KEY?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete secret' }));
    await waitFor(() => expect(deleted).toEqual(['SPARE_KEY']));
  });
});

describe('MCP servers', () => {
  it('shows each server’s state and tools, and turns one off', async () => {
    const updates: unknown[] = [];
    server.use(
      http.get(api('/v1/mcp-servers'), () => HttpResponse.json({ items: [github, wiki] })),
      http.patch(api('/v1/mcp-servers/:id'), async ({ request }) => {
        updates.push(await request.json());
        return HttpResponse.json({ ...github, enabled: false });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/mcp');
    const user = userEvent.setup();
    const githubPanel = await screen.findByRole('group', { name: /GitHub/ });
    expect(githubPanel).toHaveTextContent('Ready');
    await user.click(within(githubPanel).getByRole('button', { name: '2 tools' }));
    const tools = within(githubPanel).getByRole('list', { name: 'GitHub’s tools' });
    expect(tools).toHaveTextContent('search_issues');
    expect(tools).toHaveTextContent('Open an issue.');

    const wikiPanel = screen.getByRole('group', { name: /Wiki/ });
    expect(wikiPanel).toHaveTextContent('Failed');
    expect(wikiPanel).toHaveTextContent('Private network');
    expect(within(wikiPanel).getByRole('alert')).toHaveTextContent('It can’t connect: connection refused');
    expect(within(wikiPanel).getByRole('button', { name: 'Its tools aren’t known yet' })).toBeDisabled();

    await user.click(within(githubPanel).getByRole('switch', { name: 'GitHub enabled' }));
    await waitFor(() => expect(updates).toEqual([{ enabled: false }]));
  });

  it('adds a server whose credential comes from the vault', async () => {
    const created: unknown[] = [];
    server.use(
      http.get(api('/v1/mcp-servers'), () => HttpResponse.json({ items: [github] })),
      http.get(api('/v1/secrets'), () => HttpResponse.json({ items: [githubToken, spareKey] })),
      http.post(api('/v1/mcp-servers'), async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(
          { ...github, id: '0199e000-0000-7000-8000-000000000003', slug: 'docs', name: 'Docs' },
          { status: 201 },
        );
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/mcp');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an MCP server' });
    await user.type(within(dialog).getByLabelText('Name'), 'Docs');
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('docs');
    await user.type(within(dialog).getByLabelText('URL'), 'https://docs.example.test/mcp');
    await user.click(within(dialog).getByRole('button', { name: 'Add a header' }));
    await user.type(within(dialog).getByLabelText('Header 1 name'), 'Authorization');
    await user.click(within(dialog).getByRole('combobox', { name: 'Header 1 kind' }));
    await user.click(await screen.findByRole('option', { name: 'Secret' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Header 1 secret' }));
    await user.click(await screen.findByRole('option', { name: 'SPARE_KEY' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          slug: 'docs',
          name: 'Docs',
          description: '',
          url: 'https://docs.example.test/mcp',
          headers: { Authorization: { secret: 'SPARE_KEY' } },
          allowPrivateNetwork: false,
        },
      ]),
    );
    expect(await screen.findByText('Docs added')).toBeVisible();
  });

  it('edits a server, keeping its secret header', async () => {
    const updates: unknown[] = [];
    server.use(
      http.get(api('/v1/mcp-servers'), () => HttpResponse.json({ items: [github] })),
      http.get(api('/v1/secrets'), () => HttpResponse.json({ items: [githubToken] })),
      http.patch(api('/v1/mcp-servers/:id'), async ({ request }) => {
        updates.push(await request.json());
        return HttpResponse.json(github);
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/mcp');
    const user = userEvent.setup();
    const panel = await screen.findByRole('group', { name: /GitHub/ });
    await user.click(within(panel).getByRole('button', { name: 'More for GitHub' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit GitHub' });
    expect(within(dialog).getByRole('combobox', { name: 'Header 1 secret' })).toHaveTextContent(
      'GITHUB_TOKEN',
    );
    await user.click(within(dialog).getByRole('switch', { name: 'It’s on a private network' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updates).toEqual([
        {
          name: 'GitHub',
          description: 'Issues and pull requests.',
          url: 'https://mcp.github.test/mcp',
          headers: { Authorization: { secret: 'GITHUB_TOKEN' } },
          allowPrivateNetwork: true,
        },
      ]),
    );
  });
});

describe('plugins', () => {
  it('lists what each plugin brought', async () => {
    server.use(
      http.get(api('/v1/plugins'), () => HttpResponse.json({ items: [researchKit] })),
      ...signedInHandlers(),
    );
    renderApp('/settings/plugins');
    const plugin = await screen.findByRole('group', { name: 'Research kit' });
    expect(plugin).toHaveTextContent('research-kit 1.2.0');
    expect(plugin).toHaveTextContent('Installed');
    expect(plugin).toHaveTextContent('2 skills');
    expect(plugin).toHaveTextContent('1 server');
    expect(plugin).toHaveTextContent('acme/agent-plugins/plugins/research @ 1a2b3c4');
  });

  it('looks a plugin over before installing it, with the values it needs', async () => {
    const previews: unknown[] = [];
    const installs: unknown[] = [];
    server.use(
      http.get(api('/v1/plugins'), () => HttpResponse.json({ items: [] })),
      http.post(api('/v1/plugins/preview'), async ({ request }) => {
        previews.push(await request.json());
        return HttpResponse.json(preview);
      }),
      http.post(api('/v1/plugins'), async ({ request }) => {
        installs.push(await request.json());
        return HttpResponse.json({ ...researchKit, status: 'installing' }, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/plugins');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Install a plugin' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Install a plugin' });
    // Its GitHub address will do, and a folder with slashes around it.
    await user.type(within(dialog).getByLabelText('Repository'), 'https://github.com/acme/agent-plugins');
    await user.type(within(dialog).getByLabelText('Folder'), '/plugins/research/');
    await user.click(within(dialog).getByRole('button', { name: 'Look at it' }));
    await waitFor(() =>
      expect(previews).toEqual([
        { source: { kind: 'github', repo: 'acme/agent-plugins', path: 'plugins/research' } },
      ]),
    );

    const look = await screen.findByRole('dialog', { name: 'Install Research kit?' });
    expect(look).toHaveTextContent('Pinned to 1a2b3c4');
    expect(look).toHaveTextContent('Its server runs code from npm.');
    expect(within(look).getByRole('region', { name: 'Skills' })).toHaveTextContent('deep-search');
    expect(within(look).getByRole('checkbox', { name: /research-search/ })).toBeChecked();
    // A required value first.
    const install = within(look).getByRole('button', { name: 'Install' });
    expect(install).toBeDisabled();
    await user.type(within(look).getByLabelText('SEARCH_KEY'), 'not-a-real-key');
    await user.click(within(look).getByRole('button', { name: 'No network' }));
    await user.click(install);

    await waitFor(() =>
      expect(installs).toEqual([
        {
          previewId: preview.id,
          network: 'none',
          inputs: { SEARCH_KEY: 'not-a-real-key', REGION: 'eu' },
          servers: { search: { enabled: true } },
        },
      ]),
    );
    expect(await screen.findByText('Research kit installed')).toBeVisible();
    expect(screen.getByText('Its servers are starting.')).toBeVisible();
  });

  it('uninstalls one after saying what goes with it', async () => {
    const removed: string[] = [];
    server.use(
      http.get(api('/v1/plugins'), () => HttpResponse.json({ items: [researchKit] })),
      http.delete(api('/v1/plugins/:id'), ({ params }) => {
        removed.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/plugins');
    const user = userEvent.setup();
    const plugin = await screen.findByRole('group', { name: 'Research kit' });
    await user.click(within(plugin).getByRole('button', { name: 'Uninstall' }));
    const confirm = await screen.findByRole('dialog', { name: 'Uninstall Research kit?' });
    expect(confirm).toHaveTextContent('the secrets it made are deleted');
    await user.click(within(confirm).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(removed).toEqual([researchKit.id]));
    expect(await screen.findByText('Research kit uninstalled')).toBeVisible();
  });
});

describe('skills', () => {
  it('lists them by plugin, each with its files', async () => {
    const { files: _files, ...summary } = deepSearch;
    server.use(
      http.get(api('/v1/skills'), () => HttpResponse.json({ items: [summary] })),
      http.get(api('/v1/skills/:id'), () => HttpResponse.json(deepSearch)),
      http.get(api('/v1/plugins'), () => HttpResponse.json({ items: [researchKit] })),
      ...signedInHandlers(),
    );
    renderApp('/settings/skills');
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: 'Research kit' });
    expect(group).toHaveTextContent('deep-search');
    expect(group).toHaveTextContent('Needs: web_search');
    await user.click(within(group).getByRole('button', { name: 'Files' }));
    const dialog = await screen.findByRole('dialog', { name: 'deep-search' });
    expect(dialog).toHaveTextContent('research-kit/deep-search');
    const files = await within(dialog).findByRole('list', { name: 'Files' });
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['SKILL.md', 'scripts/rank.py', 'reference/sources.md']);
  });
});
