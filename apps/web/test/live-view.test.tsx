import type { BrowserSession, BrowserViewerInput, Task } from '@superagent/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http, ws } from 'msw';
import { describe, expect, it } from 'vitest';
import { keystrokes, typedText } from '../src/features/browsers/live-view';
import { api, DEVICE_TOKEN, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const FRAME = 'AAAA';

/** The live view's status: connecting, live, who has the browser. */
const status = () => screen.getByRole('status', { name: 'Browser' });

function session(current: Task, overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    kind: 'task',
    taskId: current.id,
    taskNumber: current.number,
    identity: 'work-google',
    url: 'https://example.com/',
    title: 'Example',
    takenOver: false,
    viewers: 1,
    openedAt: '2026-10-08T09:00:00.000Z',
    lastUsedAt: '2026-10-08T09:01:00.000Z',
    ...overrides,
  };
}

/**
 * A task with its browser open, and its live view played by the test: what the page sends is kept,
 * and `live.client` lets the test send frames and events.
 */
function withLiveBrowser(current: Task) {
  const received: BrowserViewerInput[] = [];
  const urls: string[] = [];
  const live: { client?: { send(data: string): void; close(code?: number, reason?: string): void } } = {};
  const stream = ws.link(`ws://localhost:3000/v1/tasks/${current.id}/browser/stream`);
  return {
    received,
    urls,
    live,
    handlers: [
      stream.addEventListener('connection', ({ client }) => {
        urls.push(client.url.toString());
        live.client = client;
        client.addEventListener('message', (event) => {
          received.push(JSON.parse(String(event.data)) as BrowserViewerInput);
        });
        client.send(JSON.stringify({ status: 'connected' }));
      }),
      http.get(api(`/v1/tasks/${current.id}`), () => HttpResponse.json(current)),
      http.get(api(`/v1/tasks/${current.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${current.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${current.id}/browser`), () => HttpResponse.json(session(current))),
      ...signedInHandlers({ tasks: [current] }),
    ],
  };
}

describe('live view input', () => {
  it('types what a key types: printable characters and Enter, not shortcuts', () => {
    expect(typedText({ key: 'a', ctrlKey: false, metaKey: false })).toBe('a');
    expect(typedText({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe('\r');
    expect(typedText({ key: 'a', ctrlKey: true, metaKey: false })).toBeUndefined();
    expect(typedText({ key: 'ArrowLeft', ctrlKey: false, metaKey: false })).toBeUndefined();
    expect(typedText({ key: '😀', ctrlKey: false, metaKey: false })).toBe('😀');
  });

  it('turns text into the key presses that type it', () => {
    expect(keystrokes('a\nb')).toEqual([
      { type: 'keyboard', eventType: 'keyDown', key: 'a', text: 'a' },
      { type: 'keyboard', eventType: 'keyUp', key: 'a' },
      { type: 'keyboard', eventType: 'keyDown', key: 'Enter', text: '\r' },
      { type: 'keyboard', eventType: 'keyUp', key: 'Enter' },
      { type: 'keyboard', eventType: 'keyDown', key: 'b', text: 'b' },
      { type: 'keyboard', eventType: 'keyUp', key: 'b' },
    ]);
    expect(keystrokes('x'.repeat(5_000))).toHaveLength(4_000);
  });
});

describe('a task’s browser', () => {
  it('shows it live, and takes it over to type into it', async () => {
    const current = task({ title: 'Browse the docs' });
    const { received, urls, live, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();

    // Connected with this browser's token (a WebSocket can't carry it in a header).
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0] ?? '').searchParams.get('apiKey')).toBe(DEVICE_TOKEN);
    expect(await screen.findByText('No browser open')).toBeVisible();

    live.client?.send(JSON.stringify({ url: 'https://example.com/' }));
    live.client?.send(FRAME);
    const page = await screen.findByRole('img', { name: 'The page at https://example.com/' });
    expect(page).toHaveAttribute('src', `data:image/jpeg;base64,${FRAME}`);
    expect(status()).toHaveTextContent('Live');
    expect(status()).toHaveTextContent('Agents have it');
    expect(screen.getByText('Signed in as work-google', { exact: false })).toBeVisible();
    // Until it's taken over, the page takes no input.
    expect(screen.getByLabelText('Type into the page')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(received).toEqual([{ type: 'takeover', on: true }]));
    live.client?.send(JSON.stringify({ status: 'taken_over' }));
    await waitFor(() => expect(status()).toHaveTextContent('You have it'));

    const keys = screen.getByLabelText('Type into the page');
    await waitFor(() => expect(keys).toBeEnabled());
    received.length = 0;
    await user.type(keys, 'Hi{Enter}');
    await waitFor(() =>
      expect(received).toEqual([
        { type: 'keyboard', eventType: 'keyDown', key: 'H', code: 'KeyH', modifiers: 0, text: 'H' },
        { type: 'keyboard', eventType: 'keyUp', key: 'H', code: 'KeyH', modifiers: 0 },
        { type: 'keyboard', eventType: 'keyDown', key: 'i', code: 'KeyI', modifiers: 0, text: 'i' },
        { type: 'keyboard', eventType: 'keyUp', key: 'i', code: 'KeyI', modifiers: 0 },
        { type: 'keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0, text: '\r' },
        { type: 'keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 },
      ]),
    );

    // Text that comes without keys (a phone's keyboard, dictation) and pasted text: typed as keys.
    received.length = 0;
    fireEvent.input(keys, { target: { value: 'ok' } });
    expect(keys).toHaveValue('');
    fireEvent.paste(keys, { clipboardData: { getData: () => 'pw' } });
    await waitFor(() =>
      expect(
        received.map((input) => (input.type === 'keyboard' ? `${input.eventType}:${input.key}` : '')),
      ).toEqual([
        'keyDown:o',
        'keyUp:o',
        'keyDown:k',
        'keyUp:k',
        'keyDown:p',
        'keyUp:p',
        'keyDown:w',
        'keyUp:w',
      ]),
    );

    // An address without a scheme is a web address.
    received.length = 0;
    const address = screen.getByLabelText('Address');
    await user.clear(address);
    await user.type(address, 'example.org{Enter}');
    await waitFor(() => expect(received).toEqual([{ type: 'navigate', url: 'https://example.org' }]));
    live.client?.send(JSON.stringify({ error: 'blocked_url', message: 'Not a public address: 10.0.0.1' }));
    expect(await screen.findByText('Not a public address: 10.0.0.1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Not a public address: 10.0.0.1')).toBeNull();

    received.length = 0;
    await user.click(screen.getByRole('button', { name: 'Give it back' }));
    await waitFor(() => expect(received).toEqual([{ type: 'takeover', on: false }]));
  });

  it('says when its browser closes, and when its token is revoked', async () => {
    const current = task();
    const { live, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    await waitFor(() => expect(live.client).toBeDefined());
    live.client?.send(FRAME);
    await waitFor(() => expect(status()).toHaveTextContent('Live'));

    live.client?.send(JSON.stringify({ status: 'browser_closed' }));
    expect(await screen.findByText('No browser open')).toBeVisible();
    expect(status()).toHaveTextContent('Not open');

    live.client?.close(1008, 'Token revoked');
    expect(await screen.findByText('This browser’s token was revoked, so the view closed.')).toBeVisible();
  });

  it('closes its browser after asking', async () => {
    const current = task();
    let closed = 0;
    const { handlers } = withLiveBrowser(current);
    server.use(
      http.delete(api(`/v1/tasks/${current.id}/browser`), () => {
        closed++;
        return new HttpResponse(null, { status: 204 });
      }),
      ...handlers,
    );
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Close the browser' }));
    const confirm = await screen.findByRole('dialog', { name: 'Close the task’s browser?' });
    await user.click(screen.getByRole('button', { name: 'Close browser' }));
    await waitFor(() => expect(closed).toBe(1));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Close the browser' })).toBeNull();
  });
});
