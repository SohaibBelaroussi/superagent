import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { MyPush, PushDevice, PushPayload } from '@superagent/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { AppState, Platform } from 'react-native';
import { PUSH_TASK } from '../src/push/background';
import { openPush } from '../src/push/crypto';
import * as registration from '../src/push/registration';
import { keystoreText, notifications, phone, putInKeystore, tasks } from './device';
import { api, approval, PHONE, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const PUSH_KEY = 'superagent.push-key';

/** What the server does with a payload (D54): AES-256-GCM with the phone's key. */
function seal(key: Buffer, payload: PushPayload): Record<string, string> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('superagent-push-v1'));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { v: '1', c: Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64') };
}

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Refused', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const waiting = task({ phase: 'waiting', title: 'Find the papers' });
const asking = task({ phase: 'waiting', number: 8, title: 'Plan the launch' });

function approvalPush(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    kind: 'approval',
    title: 'Approve web_search?',
    body: `#${waiting.number} Find the papers`,
    taskId: waiting.id,
    itemId: `approval:run-${waiting.number}:call-1`,
    at: new Date().toISOString(),
    ...overrides,
  };
}

/** Android running the push task: a push arriving, or an action tapped on a notification. */
async function runTask(data: unknown): Promise<void> {
  const executor = tasks.get(PUSH_TASK);
  if (!executor) throw new Error('The push task was never defined');
  await act(async () => {
    await executor({ data, error: null, executionInfo: { taskName: PUSH_TASK } });
  });
}

/** A key this phone holds, as registering for push leaves it. */
function holdKey(): Buffer {
  const key = randomBytes(32);
  putInKeystore(PUSH_KEY, key.toString('base64'));
  return key;
}

/** An action on a drawn notification, as Android hands it to the background task (its data as JSON). */
function tapped(identifier: string, actionIdentifier: string, userText?: string) {
  const shown = phone.shade.get(identifier);
  if (!shown) throw new Error(`No notification ${identifier}`);
  return {
    actionIdentifier,
    userText,
    notification: {
      date: 1_760_000_000_000,
      request: {
        identifier,
        content: {
          title: shown.content.title,
          body: shown.content.body,
          dataString: JSON.stringify(shown.content.data),
        },
        trigger: shown.trigger,
      },
    },
  };
}

describe('push', () => {
  const os = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'android';
  });
  afterEach(() => {
    Platform.OS = os;
  });

  it('reads only what was sealed with this phone’s key', () => {
    const key = randomBytes(32);
    const data = seal(key, approvalPush());
    expect(openPush(key.toString('base64'), data)).toMatchObject({
      kind: 'approval',
      title: 'Approve web_search?',
    });
    expect(openPush(randomBytes(32).toString('base64'), data)).toBeNull();

    const tampered = Buffer.from(data.c ?? '', 'base64');
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(openPush(key.toString('base64'), { v: '1', c: tampered.toString('base64') })).toBeNull();
    expect(openPush(key.toString('base64'), { v: '2', c: data.c })).toBeNull();
    expect(openPush(key.toString('base64'), { title: 'Approve web_search?' })).toBeNull();
  });

  it('draws a push as a notification of its kind, private on the lock screen, with its actions', async () => {
    const key = holdKey();
    await runTask({ data: seal(key, approvalPush()) });

    const shown = phone.shade.get(`approval:run-${waiting.number}:call-1`);
    expect(shown?.content).toMatchObject({
      title: 'Approve web_search?',
      body: `#${waiting.number} Find the papers`,
      subtitle: 'Approvals',
      categoryIdentifier: 'approval',
    });
    expect(shown?.trigger).toEqual({ channelId: 'approval' });
    expect(phone.channels.get('approval')).toMatchObject({ name: 'Approvals', lockscreenVisibility: 0 });
    expect([...phone.channels.keys()].sort()).toEqual([
      'approval',
      'chief',
      'problem',
      'question',
      'review',
      'test',
    ]);
    expect(phone.categories.get('approval')?.map((action) => action.identifier)).toEqual([
      'approve',
      'decline',
    ]);
    expect(phone.categories.get('question')?.map((action) => action.identifier)).toEqual(['reply']);
  });

  it('drops a push this phone can’t read', async () => {
    holdKey();
    await runTask({ data: seal(randomBytes(32), approvalPush()) });
    await runTask({ data: { title: 'Plain text', message: 'not sealed' } });
    expect(phone.shade.size).toBe(0);
  });

  it('approves from the notification once, however often Android delivers the tap', async () => {
    signedIn();
    const key = holdKey();
    const seen: Array<string | null> = [];
    server.use(
      http.post(api('/v1/attention/:id/approve'), ({ request, params }) => {
        seen.push(request.headers.get('idempotency-key'));
        return HttpResponse.json({
          id: '0199c000-0000-7000-8000-000000000001',
          kind: 'approve',
          target: String(params.id),
          reason: null,
          status: 'applied',
          taskId: waiting.id,
          createdAt: new Date().toISOString(),
        });
      }),
    );
    await runTask({ data: seal(key, approvalPush()) });
    const id = `approval:run-${waiting.number}:call-1`;
    const tap = tapped(id, 'approve');

    // The background task, and the app's listener when it next starts.
    await runTask(tap);
    await runTask(tap);

    expect(seen).toEqual([`push:${id}:approve`]);
    expect(phone.shade.has(id)).toBe(false);
  });

  it('sends an answer typed on the notification to the task’s lead', async () => {
    signedIn();
    const key = holdKey();
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/tasks/:id/messages'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(asking);
      }),
    );
    await runTask({
      data: seal(key, {
        kind: 'question',
        title: '#8 has a question',
        body: 'Which markets first?',
        taskId: asking.id,
        itemId: `task:${asking.id}`,
        at: new Date().toISOString(),
      }),
    });
    await runTask(tapped(`task:${asking.id}`, 'reply', '  Europe, then the US.  '));

    expect(bodies).toEqual([{ message: 'Europe, then the US.', mode: 'steer' }]);
    expect(phone.shade.has(`task:${asking.id}`)).toBe(false);
  });

  it('puts the notification back saying what went wrong', async () => {
    signedIn();
    const key = holdKey();
    server.use(
      http.post(api('/v1/attention/:id/approve'), () => problem(500, 'The database is restarting.')),
    );
    await runTask({ data: seal(key, approvalPush()) });
    const id = `approval:run-${waiting.number}:call-1`;
    await runTask(tapped(id, 'approve'));

    expect(phone.shade.get(id)?.content.body).toMatch(/^Couldn’t approve: /);
    expect(phone.shade.get(id)?.content.categoryIdentifier).toBe('approval');
  });

  it('lets a call decided elsewhere go quietly', async () => {
    signedIn();
    const key = holdKey();
    server.use(http.post(api('/v1/attention/:id/decline'), () => problem(409, 'Decided already.')));
    await runTask({ data: seal(key, approvalPush()) });
    const id = `approval:run-${waiting.number}:call-1`;
    await runTask(tapped(id, 'decline'));
    expect(phone.shade.has(id)).toBe(false);
  });
});

describe('push with the app open', () => {
  const state = AppState.currentState;
  beforeEach(() => {
    jest.spyOn(registration, 'pushAvailable').mockReturnValue(true);
    AppState.currentState = 'active';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    AppState.currentState = state;
  });

  it('shows a push as a banner inside the app, which opens its task', async () => {
    signedIn();
    const key = holdKey();
    server.use(...signedInHandlers({ tasks: [waiting], attention: [approval(waiting)] }));
    await renderApp('/');
    await screen.findByText('Ada wants to run web_search');

    await runTask({ data: seal(key, approvalPush()) });
    expect(phone.shade.size).toBe(0);
    await fireEvent.press(await screen.findByText('Approve web_search?'));

    expect(await screen.findByText('Find the papers')).toBeOnTheScreen();
    // The launcher's badge counts what needs you.
    expect(phone.badge).toBe(1);
  });

  it('opens a notification’s task when it’s tapped', async () => {
    signedIn();
    server.use(...signedInHandlers({ tasks: [waiting] }));
    await renderApp('/');
    await waitFor(() => expect(phone.responseListeners).toHaveLength(1));

    await act(async () => {
      phone.responseListeners[0]?.({
        actionIdentifier: notifications.DEFAULT_ACTION_IDENTIFIER,
        notification: {
          date: 1_760_000_000_000,
          request: {
            identifier: 'approval:run-1:call-1',
            content: { data: { kind: 'approval', taskId: waiting.id, itemId: 'approval:run-1:call-1' } },
          },
        },
      });
    });
    expect(await screen.findByText('Find the papers')).toBeOnTheScreen();
  });
});

describe('notification settings', () => {
  beforeEach(() => {
    jest.spyOn(registration, 'pushAvailable').mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function pushRoutes(configured = true) {
    let mine: MyPush = { configured, device: null };
    const puts: Array<{ platform: string; pushToken: string; key: string; kinds: string[] }> = [];
    const calls: string[] = [];
    const device = (kinds: string[]): PushDevice => ({
      id: 'push-1',
      tokenId: 'phone-1',
      tokenName: PHONE,
      platform: 'android',
      kinds: kinds as PushDevice['kinds'],
      createdAt: '2026-10-09T09:00:00.000Z',
      updatedAt: new Date().toISOString(),
      lastSentAt: null,
      lastError: null,
    });
    const handlers = [
      http.get(api('/v1/push/device'), () => HttpResponse.json(mine)),
      http.put(api('/v1/push/device'), async ({ request }) => {
        const body = (await request.json()) as (typeof puts)[number];
        puts.push(body);
        mine = { configured, device: device(body.kinds) };
        return HttpResponse.json(mine.device);
      }),
      http.delete(api('/v1/push/device'), () => {
        calls.push('delete');
        mine = { configured, device: null };
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(api('/v1/push/device/test'), () => {
        calls.push('test');
        return new HttpResponse(null, { status: 204 });
      }),
    ];
    return { handlers, puts, calls };
  }

  it('turns notifications on with a key only this phone holds, then tunes and tests them', async () => {
    signedIn();
    const routes = pushRoutes();
    server.use(...routes.handlers, ...signedInHandlers());
    await renderApp('/notifications');

    await fireEvent(await screen.findByLabelText('Get notifications'), 'valueChange', true);
    await waitFor(() => expect(routes.puts).toHaveLength(1));
    expect(routes.puts[0]).toEqual({
      platform: 'android',
      pushToken: 'fcm-token-1',
      key: expect.any(String),
      kinds: ['approval', 'question', 'review', 'problem', 'chief'],
    });
    // A key of 32 bytes, and the permission asked only once the channels existed.
    expect(routes.puts[0]?.key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(phone.prompts).toBe(1);
    const channelsAt = Math.min(...notifications.setNotificationChannelAsync.mock.invocationCallOrder);
    expect(channelsAt).toBeLessThan(notifications.requestPermissionsAsync.mock.invocationCallOrder[0] ?? 0);

    await fireEvent(await screen.findByLabelText('Questions'), 'valueChange', false);
    await waitFor(() => expect(routes.puts).toHaveLength(2));
    expect(routes.puts[1]?.kinds).toEqual(['approval', 'review', 'problem', 'chief']);
    expect(routes.puts[1]?.key).toBe(routes.puts[0]?.key);

    await fireEvent.press(screen.getByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByText('Test sent')).toBeOnTheScreen();

    await fireEvent(screen.getByLabelText('Get notifications'), 'valueChange', false);
    await waitFor(() => expect(routes.calls).toContain('delete'));
    await waitFor(() => expect(screen.queryByLabelText('Questions')).toBeNull());
  });

  it('keeps the key in the keystore, and forgets it when turned off', async () => {
    signedIn();
    const routes = pushRoutes();
    server.use(...routes.handlers, ...signedInHandlers());
    await renderApp('/notifications');

    await fireEvent(await screen.findByLabelText('Get notifications'), 'valueChange', true);
    await waitFor(() => expect(routes.puts).toHaveLength(1));
    const key = routes.puts[0]?.key;
    expect(keystoreText()).toContain(key);

    await fireEvent(await screen.findByLabelText('Get notifications'), 'valueChange', false);
    await waitFor(() => expect(routes.calls).toContain('delete'));
    await waitFor(() => expect(keystoreText()).not.toContain(key));
  });

  it('says what to do when Android refuses, or the build has no Firebase project', async () => {
    signedIn();
    phone.answer = false;
    const routes = pushRoutes();
    server.use(...routes.handlers, ...signedInHandlers());
    await renderApp('/notifications');

    await fireEvent(await screen.findByLabelText('Get notifications'), 'valueChange', true);
    expect(
      await screen.findByText('Notifications are off for superagent in Android’s settings.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open Android’s settings' })).toBeOnTheScreen();
    expect(routes.puts).toHaveLength(0);

    // Allowed in Android's settings since; this build has no Firebase project.
    phone.permission = { granted: true, canAskAgain: true };
    phone.fcmToken = null;
    await fireEvent(screen.getByLabelText('Get notifications'), 'valueChange', true);
    expect(await screen.findByText(/has no Firebase project/)).toBeOnTheScreen();
    expect(routes.puts).toHaveLength(0);
  });

  it('points to the web app while the server can’t send', async () => {
    signedIn();
    const routes = pushRoutes(false);
    server.use(...routes.handlers, ...signedInHandlers());
    await renderApp('/notifications');

    expect(await screen.findByText('The server can’t send notifications yet')).toBeOnTheScreen();
    expect(screen.getByLabelText('Get notifications')).toBeDisabled();
  });
});

describe('notifications on an iPhone', () => {
  it('says they come later', async () => {
    signedIn();
    server.use(...signedInHandlers());
    await renderApp('/notifications');
    expect(await screen.findByText('Notifications come to iPhone later')).toBeOnTheScreen();
  });
});
