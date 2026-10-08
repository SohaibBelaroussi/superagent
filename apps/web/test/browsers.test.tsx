import type { BrowserIdentity, BrowserSession, Sandbox } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http, ws } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const AT = '2026-10-08T09:00:00.000Z';
const TASK_ID = '0199b000-0000-7000-8000-0000000000c1';

const identity = (overrides: Partial<BrowserIdentity>): BrowserIdentity => ({
  id: '0199e100-0000-7000-8000-000000000001',
  name: 'work-google',
  description: 'The team’s Google account',
  holder: null,
  lastUsedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});
const workGoogle = identity({});
const news = identity({
  id: '0199e100-0000-7000-8000-000000000002',
  name: 'news-sites',
  description: '',
  lastUsedAt: null,
  holder: { kind: 'task', taskId: TASK_ID, taskNumber: 12, until: AT },
});

const open = (overrides: Partial<BrowserSession>): BrowserSession => ({
  kind: 'task',
  taskId: TASK_ID,
  taskNumber: 12,
  identity: 'news-sites',
  url: 'https://news.example/',
  title: 'News',
  takenOver: false,
  viewers: 0,
  openedAt: AT,
  lastUsedAt: AT,
  ...overrides,
});

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Problem', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** The browsers' routes, keeping state: identities and the browsers open. */
function browserHandlers(
  state: { identities: BrowserIdentity[]; open: BrowserSession[] },
  seen: string[] = [],
) {
  return [
    http.get(api('/v1/browser-identities'), () => HttpResponse.json({ items: state.identities })),
    http.get(api('/v1/browser-identities/:id'), ({ params }) => {
      const found = state.identities.find((item) => item.id === params.id);
      return found ? HttpResponse.json(found) : problem(404, 'No browser identity with this id');
    }),
    http.post(api('/v1/browser-identities'), async ({ request }) => {
      const body = (await request.json()) as { name: string; description: string };
      seen.push(`create ${JSON.stringify(body)}`);
      if (state.identities.some((item) => item.name === body.name)) return problem(409, 'Taken');
      const created = identity({
        id: '0199e100-0000-7000-8000-000000000003',
        ...body,
        lastUsedAt: null,
      });
      state.identities = [...state.identities, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete(api('/v1/browser-identities/:id'), ({ params }) => {
      seen.push(`delete ${params.id}`);
      state.identities = state.identities.filter((item) => item.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(api('/v1/browser-identities/:id/session'), ({ params }) => {
      seen.push(`open ${params.id}`);
      const found = state.identities.find((item) => item.id === params.id);
      if (!found) return problem(404, 'No such identity');
      found.holder = { kind: 'owner', taskId: null, taskNumber: null, until: AT };
      const session = open({
        kind: 'sign-in',
        taskId: null,
        taskNumber: null,
        identity: found.name,
        url: null,
      });
      state.open = [...state.open, session];
      return HttpResponse.json(session, { status: 201 });
    }),
    http.delete(api('/v1/browser-identities/:id/session'), ({ params }) => {
      seen.push(`close ${params.id}`);
      const found = state.identities.find((item) => item.id === params.id);
      if (found) found.holder = null;
      state.open = state.open.filter((item) => item.kind !== 'sign-in' || item.identity !== found?.name);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(api('/v1/browsers'), () => HttpResponse.json({ items: state.open })),
    http.delete(api('/v1/tasks/:id/browser'), ({ params }) => {
      seen.push(`close task ${params.id}`);
      state.open = state.open.filter((item) => item.taskId !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    ...signedInHandlers(),
  ];
}

describe('browser identities', () => {
  it('lists them with who uses them, and makes a new one', async () => {
    const seen: string[] = [];
    const state = { identities: [workGoogle, news], open: [] as BrowserSession[] };
    server.use(...browserHandlers(state, seen));
    renderApp('/settings/browsers');
    const user = userEvent.setup();

    const list = await screen.findByRole('list', { name: 'Identities' });
    const [google, sites] = within(list).getAllByRole('listitem');
    expect(google).toHaveTextContent('work-google');
    expect(google).toHaveTextContent('The team’s Google account');
    expect(sites).toHaveTextContent('In use by task #12');
    expect(sites).toHaveTextContent('never used');
    // A task's browser holds it: no signing in meanwhile.
    expect(
      within(sites as HTMLElement).getByRole('button', { name: 'Sign in as news-sites' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'New identity' }));
    const dialog = await screen.findByRole('dialog', { name: 'New identity' });
    await user.type(within(dialog).getByLabelText('Name'), 'Not A Slug!');
    await user.click(within(dialog).getByRole('button', { name: 'Make identity' }));
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription(
      'Lowercase letters, digits and dashes, up to 40.',
    );
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Work-Google');
    await user.click(within(dialog).getByRole('button', { name: 'Make identity' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription(
        'There’s an identity with this name.',
      ),
    );
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'shop');
    await user.type(within(dialog).getByLabelText('What it’s for'), 'The shop’s admin');
    await user.click(within(dialog).getByRole('button', { name: 'Make identity' }));
    expect(await screen.findByText('shop made')).toBeVisible();
    expect(seen.at(-1)).toBe(`create ${JSON.stringify({ name: 'shop', description: 'The shop’s admin' })}`);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
  });

  it('signs one in through its browser, then saves the sign-ins', async () => {
    const seen: string[] = [];
    const state = { identities: [workGoogle], open: [] as BrowserSession[] };
    const connections: string[] = [];
    const stream = ws.link(`ws://localhost:3000/v1/browser-identities/${workGoogle.id}/stream`);
    server.use(
      stream.addEventListener('connection', ({ client }) => {
        connections.push(client.url.pathname);
        client.send(JSON.stringify({ status: 'connected' }));
        client.send('AAAA');
      }),
      ...browserHandlers(state, seen),
    );
    const { router } = renderApp('/settings/browsers');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in as work-google' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/settings/browsers/${workGoogle.id}/sign-in`),
    );
    expect(await screen.findByRole('heading', { name: 'Sign in as work-google', level: 1 })).toBeVisible();
    // A sign-in session is the owner's from the start: no taking over.
    await waitFor(() => expect(screen.getByLabelText('Type into the page')).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(connections).toEqual([`/v1/browser-identities/${workGoogle.id}/stream`]);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Sign-ins saved')).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/browsers'));
    expect(seen).toEqual([`open ${workGoogle.id}`, `close ${workGoogle.id}`]);
  });

  it('says when the identity is gone, and offers to open its browser when it isn’t open', async () => {
    const state = { identities: [workGoogle], open: [] as BrowserSession[] };
    server.use(...browserHandlers(state));
    const { unmount } = renderApp('/settings/browsers/0199e100-0000-7000-8000-0000000000ff/sign-in');
    expect(await screen.findByRole('heading', { name: 'No such identity', level: 1 })).toBeVisible();
    unmount();

    renderApp(`/settings/browsers/${workGoogle.id}/sign-in`);
    expect(await screen.findByText('Its browser isn’t open')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open its browser' })).toBeVisible();
  });

  it('deletes one after asking', async () => {
    const seen: string[] = [];
    const state = { identities: [workGoogle], open: [] as BrowserSession[] };
    server.use(...browserHandlers(state, seen));
    renderApp('/settings/browsers');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete work-google' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete work-google?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete identity' }));
    expect(await screen.findByText('work-google deleted')).toBeVisible();
    expect(seen).toEqual([`delete ${workGoogle.id}`]);
    expect(await screen.findByText('No identities yet')).toBeVisible();
  });
});

describe('open browsers', () => {
  it('lists each with what it is, and closes them', async () => {
    const seen: string[] = [];
    const signingIn = identity({ holder: { kind: 'owner', taskId: null, taskNumber: null, until: AT } });
    const state = {
      identities: [signingIn, news],
      open: [
        open({ takenOver: true, viewers: 2 }),
        open({
          kind: 'sign-in',
          taskId: null,
          taskNumber: null,
          identity: 'work-google',
          url: null,
          title: null,
        }),
        open({
          kind: 'reader',
          taskId: null,
          taskNumber: null,
          identity: null,
          url: 'about:blank',
          title: '',
        }),
      ],
    };
    server.use(...browserHandlers(state, seen));
    renderApp('/settings/browsers');
    const user = userEvent.setup();

    const list = await screen.findByRole('list', { name: 'Open browsers' });
    const [task, signIn, reader] = within(list).getAllByRole('listitem');
    expect(within(task as HTMLElement).getByRole('link', { name: 'Task #12' })).toHaveAttribute(
      'href',
      `/tasks/${TASK_ID}?view=browser`,
    );
    expect(task).toHaveTextContent('as news-sites');
    expect(task).toHaveTextContent('You have it');
    expect(task).toHaveTextContent('2 watching');
    expect(
      within(signIn as HTMLElement).getByRole('link', { name: 'Signing in as work-google' }),
    ).toHaveAttribute('href', `/settings/browsers/${signingIn.id}/sign-in`);
    expect(reader).toHaveTextContent('The page reader');
    expect(within(reader as HTMLElement).queryByRole('button')).toBeNull();

    await user.click(within(task as HTMLElement).getByRole('button', { name: 'Close task #12’s browser' }));
    expect(await screen.findByText('Browser closed')).toBeVisible();
    await user.click(
      within(signIn as HTMLElement).getByRole('button', { name: 'Close work-google’s sign-in' }),
    );
    expect(await screen.findByText('Sign-ins saved')).toBeVisible();
    expect(seen).toEqual([`close task ${TASK_ID}`, `close ${signingIn.id}`]);
  });
});

describe('sandboxes', () => {
  const sandbox: Sandbox = {
    id: TASK_ID,
    taskId: TASK_ID,
    taskNumber: 12,
    taskTitle: 'Score frameworks',
    profile: 'dev',
    state: 'running',
    createdAt: AT,
    lastUsedAt: null,
  };

  it('lists them with their tasks, and removes one after asking', async () => {
    let sandboxes = [
      sandbox,
      {
        ...sandbox,
        id: '0199b000-0000-7000-8000-0000000000c2',
        taskId: '0199b000-0000-7000-8000-0000000000c2',
        taskNumber: 13,
        state: 'stopped' as const,
      },
    ];
    const removed: string[] = [];
    server.use(
      http.get(api('/v1/sandboxes'), () => HttpResponse.json({ items: sandboxes })),
      http.delete(api('/v1/sandboxes/:id'), ({ params }) => {
        removed.push(String(params.id));
        sandboxes = sandboxes.filter((item) => item.taskId !== params.id);
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/sandboxes');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Sandboxes' });
    const [running, stopped] = within(list).getAllByRole('listitem');
    expect(
      within(running as HTMLElement).getByRole('link', { name: '#12 Score frameworks' }),
    ).toHaveAttribute('href', `/tasks/${TASK_ID}?view=files`);
    expect(running).toHaveTextContent('Running');
    expect(running).toHaveTextContent('not used yet');
    expect(stopped).toHaveTextContent('Stopped');

    await user.click(
      within(running as HTMLElement).getByRole('button', {
        name: 'Remove the sandbox of #12 Score frameworks',
      }),
    );
    const confirm = await screen.findByRole('dialog', {
      name: 'Remove the sandbox of #12 Score frameworks?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Remove sandbox' }));
    expect(await screen.findByText('Sandbox removed')).toBeVisible();
    expect(removed).toEqual([TASK_ID]);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
  });

  it('says when sandboxes are off', async () => {
    server.use(
      http.get(api('/v1/sandboxes'), () =>
        problem(503, 'Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN'),
      ),
      ...signedInHandlers(),
    );
    renderApp('/settings/sandboxes');
    expect(await screen.findByText('Sandboxes aren’t available', {}, { timeout: 8_000 })).toBeVisible();
    expect(screen.getByText('Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN')).toBeVisible();
  });
});
