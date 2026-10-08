import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationsOn } from '../src/lib/notifications';
import { api, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

describe('the command palette', () => {
  it('opens with Ctrl+K and goes where you pick', async () => {
    const draft = task({ title: 'Draft the weekly update', phase: 'working' });
    server.use(
      http.get(api(`/v1/tasks/${draft.id}`), () => HttpResponse.json(draft)),
      http.get(api(`/v1/tasks/${draft.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${draft.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      ...signedInHandlers({ tasks: [draft] }),
    );
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /^Good/ });
    const user = userEvent.setup();

    await user.keyboard('{Control>}k{/Control}');
    const search = await screen.findByRole('combobox', { name: 'Search pages, tasks and actions' });
    await user.type(search, 'weekly');
    expect(screen.queryByRole('option', { name: /inbox/i })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${draft.id}`));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'board');
    await user.click(screen.getByRole('option', { name: 'Board' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/board'));
  });

  it('asks the chief what you typed, in your conversation', async () => {
    const sent: unknown[] = [];
    server.use(
      http.get(api('/v1/chief/messages'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(
        api('/v1/chief/stream'),
        () => new HttpResponse(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
      ),
      http.post(api('/v1/chief/messages'), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ delivery: 'started' }, { status: 202 });
      }),
      ...signedInHandlers(),
    );
    const { router } = renderApp('/board');
    await screen.findByRole('heading', { level: 1, name: 'Board' });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'what is late this week');
    expect(screen.getByRole('option', { name: 'Ask the chief: “what is late this week”' })).toBeVisible();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/chief'));
    await waitFor(() => expect(sent).toEqual([{ message: 'what is late this week' }]));
  });

  it('closes with Escape, and with Ctrl+K again', async () => {
    server.use(...signedInHandlers());
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /^Good/ });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument(),
    );
  });
});

describe('the command palette, with words that name an action', () => {
  it('runs the action, and asks the chief only when nothing else fits', async () => {
    // No handler for /v1/chief/messages: asking the chief would fail the test.
    server.use(...signedInHandlers());
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /^Good/ });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'dark');
    // The chief is offered too, last.
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options.at(-1)).toBe('Ask the chief: “dark”');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    expect(router.state.location.pathname).toBe('/');

    // Closed by the shortcut, it opens empty again.
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'boa');
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument(),
    );
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('combobox', { name: /search pages/i })).toHaveValue('');
  });
});

describe('the command palette, for the organization', () => {
  it('finds agents by name or department, and opens a new department', async () => {
    server.use(...signedInHandlers());
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /^Good/ });
    const user = userEvent.setup();

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'research lead');
    expect(screen.getByRole('option', { name: /^Ada/ })).toHaveTextContent('Lead, Research');
    await user.click(screen.getByRole('option', { name: /^Ada/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/research-lead'));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: /search pages/i }), 'new department');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'New department' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/departments');
  });
});

/** A browser's Notification, recorded. */
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = 'granted';
    return 'granted' as NotificationPermission;
  });
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.shown.push(this);
  }
}

describe('notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    FakeNotification.shown = [];
    FakeNotification.permission = 'default';
  });

  const approval = (taskId: string, number: number, since: string) => ({
    id: 'approval:run-1:call-1',
    kind: 'approval',
    title: 'Ada wants to run web_search',
    detail: `#${number} Find papers`,
    taskId,
    taskNumber: number,
    departmentId: null,
    agent: 'research-lead',
    tool: 'web_search',
    since,
  });

  it('are turned on from the account menu, then tell of new things while the app is hidden', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('isSecureContext', true);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const waiting = task({ title: 'Find papers', phase: 'waiting' });
    const state = { items: [] as Array<Record<string, unknown>> };
    server.use(
      http.get(api('/v1/attention'), () => HttpResponse.json({ items: state.items })),
      http.get(api(`/v1/tasks/${waiting.id}`), () => HttpResponse.json(waiting)),
      http.get(api(`/v1/tasks/${waiting.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${waiting.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      ...signedInHandlers({ tasks: [waiting] }),
    );
    const { router, queryClient } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Account and theme' }));
    await user.click(await screen.findByRole('menuitem', { name: /notify me when something needs me/i }));
    await waitFor(() => expect(notificationsOn()).toBe(true));
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    // A first one, to be sure this browser can show them.
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(['Notifications are on']);

    // The app goes to the background; an approval arrives.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const since = '2026-10-08T10:00:00.000Z';
    state.items = [approval(waiting.id, waiting.number, since)];
    await queryClient.invalidateQueries({ queryKey: ['attention'] });
    await waitFor(() =>
      expect(FakeNotification.shown.map((n) => n.title)).toEqual([
        'Notifications are on',
        'Ada wants to run web_search',
      ]),
    );
    // Tagged by item and time: if it leaves and comes back, it alerts again.
    expect(FakeNotification.shown[1]?.options).toMatchObject({ tag: `approval:run-1:call-1:${since}` });

    // Clicking it brings the app to the task.
    FakeNotification.shown[1]?.onclick?.();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${waiting.id}`));

    // The same item again is no news.
    await queryClient.invalidateQueries({ queryKey: ['attention'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeNotification.shown).toHaveLength(2);
  });

  it('say so, and stay off, where the browser can’t show them from a page', async () => {
    // Mobile browsers have the API but refuse to build a notification from a page.
    const Refusing = Object.assign(
      () => {
        throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
      },
      { permission: 'granted' as NotificationPermission, requestPermission: vi.fn(async () => 'granted') },
    );
    vi.stubGlobal('Notification', Refusing);
    vi.stubGlobal('isSecureContext', true);
    server.use(...signedInHandlers());
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Account and theme' }));
    await user.click(await screen.findByRole('menuitem', { name: /notify me when something needs me/i }));
    expect(await screen.findByText('Notifications aren’t available here')).toBeVisible();
    expect(notificationsOn()).toBe(false);
    // The app is still there.
    expect(screen.getByRole('heading', { level: 1, name: /^Good/ })).toBeVisible();
  });

  it('stay off when you block them, and say how to allow them', async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'denied';
      return 'denied';
    });
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('isSecureContext', true);
    server.use(...signedInHandlers());
    renderApp('/inbox');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notify me' }));
    expect(await screen.findByText('Notifications are blocked')).toBeVisible();
    expect(notificationsOn()).toBe(false);
    expect(FakeNotification.shown).toEqual([]);
  });
});
