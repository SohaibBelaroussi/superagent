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

  it('are turned on from the account menu, then tell of new things while the app is hidden', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('isSecureContext', true);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const waiting = task({ title: 'Find papers', phase: 'waiting' });
    const state = {
      items: [] as Array<Record<string, unknown>>,
    };
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

    // The app goes to the background; an approval arrives.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    state.items = [
      {
        id: 'approval:run-1:call-1',
        kind: 'approval',
        title: 'Ada wants to run web_search',
        detail: `#${waiting.number} Find papers`,
        taskId: waiting.id,
        taskNumber: waiting.number,
        departmentId: null,
        agent: 'research-lead',
        tool: 'web_search',
        since: new Date().toISOString(),
      },
    ];
    await queryClient.invalidateQueries({ queryKey: ['attention'] });
    await waitFor(() =>
      expect(FakeNotification.shown.map((n) => n.title)).toEqual(['Ada wants to run web_search']),
    );
    expect(FakeNotification.shown[0]?.options).toMatchObject({ tag: 'approval:run-1:call-1' });

    // Clicking it brings the app to the task.
    FakeNotification.shown[0]?.onclick?.();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${waiting.id}`));

    // The same item again is no news.
    await queryClient.invalidateQueries({ queryKey: ['attention'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeNotification.shown).toHaveLength(1);
  });
});
