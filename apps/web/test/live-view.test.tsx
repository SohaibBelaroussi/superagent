import type { BrowserSession, BrowserViewerInput, Task } from '@superagent/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http, ws } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keystrokes, modifiersOf, typedText } from '../src/features/browsers/live-view';
import { api, DEVICE_TOKEN, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const FRAME = 'AAAA';

/** The live view's status: connecting, live, who has the browser. */
const status = () => screen.getByRole('status', { name: 'Browser' });
const typing = () => screen.getByRole('textbox', { name: 'Type into the page' });

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

type Client = { send(data: string): void; close(code?: number, reason?: string): void };

/**
 * A task with its browser, and its live view played by the test as the API plays it: on each
 * connection, "connected", then who has the browser and what it shows (or that it's closed). What the
 * page sends is kept, and `live.client` lets the test send more.
 */
function withLiveBrowser(current: Task, options: { open?: boolean } = {}) {
  const received: BrowserViewerInput[] = [];
  const urls: string[] = [];
  const live: { client?: Client; open: boolean; takenOver: boolean } = {
    open: options.open ?? true,
    takenOver: false,
  };
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
          const input = JSON.parse(String(event.data)) as BrowserViewerInput;
          received.push(input);
          if (input.type === 'takeover') {
            live.takenOver = input.on;
            client.send(JSON.stringify({ status: input.on ? 'taken_over' : 'released' }));
          }
        });
        client.send(JSON.stringify({ status: 'connected' }));
        if (!live.open) {
          client.send(JSON.stringify({ status: 'browser_closed' }));
          return;
        }
        client.send(JSON.stringify({ status: live.takenOver ? 'taken_over' : 'released' }));
        client.send(JSON.stringify({ status: 'streaming' }));
        client.send(JSON.stringify({ viewport: { width: 1280, height: 800 } }));
        client.send(JSON.stringify({ url: 'https://example.com/' }));
        client.send(FRAME);
      }),
      http.get(api(`/v1/tasks/${current.id}`), () => HttpResponse.json(current)),
      http.get(api(`/v1/tasks/${current.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${current.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${current.id}/browser`), () =>
        live.open ? HttpResponse.json(session(current)) : HttpResponse.json({ status: 404 }, { status: 404 }),
      ),
      ...signedInHandlers({ tasks: [current] }),
    ],
  };
}

/** Takes the task's browser over, and puts the keyboard on the page. */
async function takeOver(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Take over' }));
  await waitFor(() => expect(status()).toHaveTextContent('You have it'));
  await user.click(screen.getByRole('button', { name: 'Start typing into the page' }));
  await waitFor(() => expect(typing()).toHaveFocus());
}

describe('live view input', () => {
  it('types what a key types: printable characters, Enter and AltGr’s characters, not shortcuts', () => {
    const keys = { ctrlKey: false, metaKey: false };
    expect(typedText({ ...keys, key: 'a' })).toBe('a');
    expect(typedText({ ...keys, key: 'Enter' })).toBe('\r');
    expect(typedText({ ...keys, key: 'a', ctrlKey: true })).toBeUndefined();
    expect(typedText({ ...keys, key: 'ArrowLeft' })).toBeUndefined();
    expect(typedText({ ...keys, key: '😀' })).toBe('😀');
    // AltGr is Ctrl and Alt on Windows: it types.
    expect(typedText({ key: '@', ctrlKey: true, metaKey: false, altGraph: true })).toBe('@');
  });

  it('sends modifiers as the page’s Chromium on Linux understands them', () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(modifiersOf({ ...none, ctrlKey: true, shiftKey: true }, false)).toBe(2 | 8);
    expect(modifiersOf({ ...none, metaKey: true }, false)).toBe(4);
    // A Mac's Cmd is Ctrl there.
    expect(modifiersOf({ ...none, metaKey: true }, true)).toBe(2);
    // AltGr is neither Ctrl nor Alt.
    expect(modifiersOf({ ...none, ctrlKey: true, altKey: true, altGraph: true }, false)).toBe(0);
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
  beforeEach(() => {
    // jsdom lays nothing out: the page's image is 640×400 at the window's corner.
    vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 400,
      right: 640,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows it live, and takes it over to type into it', async () => {
    const current = task({ title: 'Browse the docs' });
    const { received, urls, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();

    // Connected with this browser's token (a WebSocket can't carry it in a header), and shown at once.
    const page = await screen.findByRole('img', { name: 'The page at https://example.com/' });
    expect(new URL(urls[0] ?? '').searchParams.get('apiKey')).toBe(DEVICE_TOKEN);
    expect(page).toHaveAttribute('src', `data:image/jpeg;base64,${FRAME}`);
    await waitFor(() => expect(status()).toHaveTextContent('Live'));
    expect(status()).toHaveTextContent('Agents have it');
    expect(screen.getByText('Signed in as work-google', { exact: false })).toBeVisible();
    // Until it's taken over, the page takes no input, and the address bar is only the address.
    expect(typing()).toBeDisabled();
    await user.type(screen.getByLabelText('Address'), '{Enter}');
    expect(received).toEqual([]);

    await takeOver(user);
    received.length = 0;
    await user.keyboard('Hi{Enter}');
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

    // AltGr (Ctrl and Alt on Windows) types its character.
    received.length = 0;
    const altGr = { key: '@', code: 'Digit0', ctrlKey: true, altKey: true, modifierAltGraph: true };
    fireEvent.keyDown(typing(), altGr);
    fireEvent.keyUp(typing(), altGr);
    await waitFor(() =>
      expect(received).toEqual([
        { type: 'keyboard', eventType: 'keyDown', key: '@', code: 'Digit0', modifiers: 0, text: '@' },
        { type: 'keyboard', eventType: 'keyUp', key: '@', code: 'Digit0', modifiers: 0 },
      ]),
    );

    // Text that comes without keys (a phone's keyboard, dictation) and pasted text: typed as keys.
    received.length = 0;
    fireEvent.input(typing(), { target: { value: 'ok' } });
    expect(typing()).toHaveValue('');
    fireEvent.paste(typing(), { clipboardData: { getData: () => 'pw' } });
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
    expect(typing()).toHaveFocus();
    received.length = 0;
    await user.click(screen.getByRole('button', { name: 'Give it back' }));
    await waitFor(() => expect(received).toEqual([{ type: 'takeover', on: false }]));
    await waitFor(() => expect(status()).toHaveTextContent('Agents have it'));
  });

  it('counts double clicks, and puts the page’s pixels under the pointer', async () => {
    const current = task();
    const { received, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();
    await takeOver(user);
    received.length = 0;

    const view = screen.getByRole('application');
    for (let press = 0; press < 2; press++) {
      fireEvent.pointerDown(view, { clientX: 320, clientY: 100, button: 0, pointerType: 'mouse' });
      fireEvent.pointerUp(view, { clientX: 320, clientY: 100, button: 0, pointerType: 'mouse' });
    }
    // 640×400 on screen is 1280×800 in the page.
    await waitFor(() =>
      expect(
        received.map((input) =>
          input.type === 'mouse'
            ? `${input.eventType} ${input.x},${input.y} ×${input.clickCount}`
            : input.type,
        ),
      ).toEqual([
        'mousePressed 640,200 ×1',
        'mouseReleased 640,200 ×1',
        'mousePressed 640,200 ×2',
        'mouseReleased 640,200 ×2',
      ]),
    );
  });

  it('gives the keyboard back with Escape twice, and lets go of what it holds', async () => {
    const current = task();
    const { received, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();
    await takeOver(user);
    received.length = 0;

    // Shift held when the keyboard leaves: the page hears it let go.
    await user.keyboard('{Shift>}{Escape}{Escape}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start typing into the page' })).toHaveFocus(),
    );
    await waitFor(() =>
      expect(
        received.map((input) => (input.type === 'keyboard' ? `${input.eventType}:${input.key}` : '')),
      ).toEqual(['keyDown:Shift', 'keyDown:Escape', 'keyUp:Escape', 'keyUp:Shift']),
    );
    await user.keyboard('{/Shift}');
  });

  it('starts again from what the API says after a dropped connection', async () => {
    const current = task();
    const { live, handlers } = withLiveBrowser(current);
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    const user = userEvent.setup();
    await takeOver(user);

    // The connection drops; meanwhile the API gave the browser back to the agents.
    live.takenOver = false;
    live.client?.close(1011, 'Gone');
    await waitFor(() => expect(status()).toHaveTextContent('Reconnecting…'));
    await waitFor(() => expect(status()).toHaveTextContent('Agents have it'), { timeout: 4_000 });
    expect(typing()).toBeDisabled();
  });

  it('says when no browser is open, when it closes, and when its token is revoked', async () => {
    const current = task();
    const { live, handlers } = withLiveBrowser(current, { open: false });
    server.use(...handlers);
    renderApp(`/tasks/${current.id}?view=browser`);
    expect(await screen.findByText('No browser open')).toBeVisible();
    expect(status()).toHaveTextContent('Not open');

    live.client?.send(JSON.stringify({ status: 'streaming' }));
    live.client?.send(FRAME);
    await waitFor(() => expect(status()).toHaveTextContent('Live'));
    live.client?.send(JSON.stringify({ status: 'browser_closed' }));
    expect(await screen.findByText('No browser open')).toBeVisible();

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
