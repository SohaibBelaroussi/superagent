import type { AgentDefinition, AgentVersion, UpdateAgentInput } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ada, api, CAPABILITIES, research, server, signedInHandlers } from './msw';
import { renderApp } from './render';

/** Ada's world: her definition and versions as the server keeps them, and what was sent to it. */
function adaServer(versions: AgentVersion[] = [ada.current]) {
  const state = { agent: ada, versions, patches: [] as UpdateAgentInput[] };
  return {
    state,
    handlers: [
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [state.agent] })),
      http.get(api(`/v1/agents/${ada.id}/versions`), () => HttpResponse.json({ items: state.versions })),
      http.patch(api(`/v1/agents/${ada.id}`), async ({ request }) => {
        const patch = (await request.json()) as UpdateAgentInput;
        state.patches.push(patch);
        const { name, ...definition } = patch;
        const versioned = Object.keys(definition).length > 0;
        const version = versioned
          ? Math.max(...state.versions.map((v) => v.version)) + 1
          : state.agent.activeVersion;
        const current: AgentVersion = versioned
          ? { ...state.agent.current, ...definition, version, createdAt: new Date().toISOString() }
          : state.agent.current;
        if (versioned) state.versions = [current, ...state.versions];
        state.agent = {
          ...state.agent,
          name: name ?? state.agent.name,
          activeVersion: version,
          current,
          updatedAt: new Date().toISOString(),
        } satisfies AgentDefinition;
        return HttpResponse.json(state.agent);
      }),
    ],
  };
}

describe('an agent', () => {
  it('saves a change as a new version, sending only what changed', async () => {
    const { state, handlers } = adaServer();
    server.use(...handlers, ...signedInHandlers());
    renderApp('/agents/research-lead');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: /^fetch page/i }));
    await user.click(screen.getByRole('checkbox', { name: /ask me before each call/i }));
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('Saving makes version 2. Ada uses it from its next run.');
    await user.click(within(bar).getByRole('button', { name: 'Save as version 2' }));

    await waitFor(() =>
      expect(state.patches).toEqual([{ tools: [{ key: 'fetch_page', requireApproval: true }] }]),
    );
    expect(await screen.findByText('Saved as version 2')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeVisible();
  });

  it('renames without a new version', async () => {
    const { state, handlers } = adaServer();
    server.use(...handlers, ...signedInHandlers());
    renderApp('/agents/research-lead');
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Ada Lovelace');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.patches).toEqual([{ name: 'Ada Lovelace' }]));
    expect(await screen.findByText('Saved')).toBeVisible();
  });

  it('asks before leaving with unsaved changes', async () => {
    const { handlers } = adaServer();
    server.use(...handlers, ...signedInHandlers());
    const { router } = renderApp('/agents/research-lead');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('How Ada works'), ' Be brief.');
    const rail = screen.getByRole('navigation', { name: 'Main' });

    await user.click(within(rail).getByRole('link', { name: 'Board' }));
    const ask = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe('/agents/research-lead');
    expect(screen.getByLabelText('How Ada works')).toHaveValue('Lead. Be brief.');

    // Its own tabs aren't leaving.
    await user.click(screen.getByRole('tab', { name: /versions/i }));
    expect(router.state.location.search).toBe('?tab=versions');
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).not.toBeInTheDocument();

    await user.click(within(rail).getByRole('link', { name: 'Board' }));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/board'));
  });

  it('puts the agent back on an earlier version', async () => {
    const v1: AgentVersion = { ...ada.current, version: 1, instructions: 'Lead slowly.' };
    const v2: AgentVersion = { ...ada.current, version: 2, createdAt: '2026-10-05T09:00:00.000Z' };
    const activated: string[] = [];
    const { state, handlers } = adaServer([v2, v1]);
    state.agent = { ...ada, activeVersion: 2, current: v2 };
    server.use(
      http.post(api(`/v1/agents/${ada.id}/versions/:version/activate`), ({ params }) => {
        activated.push(String(params.version));
        state.agent = { ...state.agent, activeVersion: 1, current: v1, updatedAt: new Date().toISOString() };
        return HttpResponse.json(state.agent);
      }),
      ...handlers,
      ...signedInHandlers(),
    );
    renderApp('/agents/research-lead?tab=versions');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Ada’s versions' });
    const [newest, first] = within(list).getAllByRole('listitem');
    expect(newest).toHaveTextContent('In use');
    expect(newest).toHaveTextContent('Changed instructions.');
    expect(first).toHaveTextContent('The first version.');

    // What going back would change.
    await user.click(within(first as HTMLElement).getByRole('button', { name: 'View' }));
    const view = await screen.findByRole('dialog', { name: 'Version 1' });
    expect(within(view).getByText('Lead slowly.')).toBeVisible();
    expect(within(view).getByText('Removed:', { exact: false })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Version 1' })).not.toBeInTheDocument());

    await user.click(within(first as HTMLElement).getByRole('button', { name: 'Use this version' }));
    await user.click(await screen.findByRole('button', { name: 'Use version 1' }));
    await waitFor(() => expect(activated).toEqual(['1']));
    expect(await screen.findByText('Ada is on version 1')).toBeVisible();
  });

  it('gives an MCP server’s tools, all of them or some', async () => {
    const { state, handlers } = adaServer();
    server.use(
      http.get(api('/v1/capabilities'), () =>
        HttpResponse.json({
          ...CAPABILITIES,
          mcpServers: [
            {
              slug: 'github',
              name: 'GitHub',
              transport: 'http',
              status: 'ready',
              enabled: true,
              tools: [
                { name: 'create_issue', key: 'github_create_issue', description: 'Open an issue.' },
                { name: 'search_code', key: 'github_search_code', description: 'Search code.' },
              ],
            },
          ],
        }),
      ),
      ...handlers,
      ...signedInHandlers(),
    );
    renderApp('/agents/research-lead');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: /^github/i }));
    await user.click(screen.getByRole('button', { name: 'Only some' }));
    const save = () =>
      user.click(
        within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', {
          name: /save/i,
        }),
      );
    await save();
    expect(
      await screen.findByText('Pick at least one of GitHub’s tools, or give it all of them.'),
    ).toBeVisible();
    expect(state.patches).toEqual([]);

    await user.click(screen.getByRole('checkbox', { name: 'create_issue' }));
    await save();
    await waitFor(() =>
      expect(state.patches).toEqual([
        { mcp: [{ server: 'github', requireApproval: false, tools: ['create_issue'] }] },
      ]),
    );
  });

  it('archives it, and goes back to its team', async () => {
    const deleted: string[] = [];
    const { handlers } = adaServer();
    server.use(
      http.delete(api(`/v1/agents/${ada.id}`), () => {
        deleted.push(ada.id);
        return new HttpResponse(null, { status: 204 });
      }),
      ...handlers,
      ...signedInHandlers(),
    );
    const { router } = renderApp('/agents/research-lead');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive Ada…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive Ada?' });
    expect(confirm).toHaveTextContent(`Ada stops leading ${research.name}`);
    await user.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(deleted).toEqual([ada.id]));
    await waitFor(() => expect(router.state.location.pathname).toBe('/departments/research'));
    expect(router.state.location.search).toBe('?tab=team');
  });
});
