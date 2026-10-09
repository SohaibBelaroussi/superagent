import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { MyPush, PushDevice, PushPayload } from '@superagent/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { AppState, Platform } from 'react-native';
import { PUSH_TASK } from '../src/push/background';
import { openPush } from '../src/push/crypto';
import { forgetPush } from '../src/push/registration';
import { keystoreText, kvStore, notifications, phone, putInKeystore, tasks } from './device';
import { api, approval, PHONE, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const PUSH_KEY = 'superagent.push-key';

/**
 * The phone these tests run on: Android 16 (API 36) unless a test says otherwise. Push is Android's
 * for now, and Jest runs as iOS. Each test ends with the phone's push forgotten, as after signing out.
 */
function runOnAndroid() {
  const os = Platform.OS;
  const version = Object.getOwnPropertyDescriptor(Platform, 'Version');
  beforeEach(() => {
    Platform.OS = 'android';
    androidVersion(36);
  });
  afterEach(async () => {
    Platform.OS = os;
    if (version) Object.defineProperty(Platform, 'Version', version);
    await forgetPush();
  });
}

function androidVersion(api: number): void {
  Object.defineProperty(Platform, 'Version', { value: api, configurable: true, writable: true });
}

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

/** This phone's registration as the server answers it. */
function registered(kinds: string[]): PushDevice {
  return {
    id: 'push-1',
    tokenId: 'phone-1',
    tokenName: PHONE,
    platform: 'android',
    kinds: kinds as PushDevice['kinds'],
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: new Date().toISOString(),
    lastSentAt: null,
    lastError: null,
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
  runOnAndroid();

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

  it('acts only on notifications it drew', async () => {
    signedIn();
    const seen: string[] = [];
    server.use(
      http.post(api('/v1/attention/:id/approve'), ({ params }) => {
        seen.push(String(params.id));
        return HttpResponse.json({});
      }),
    );
    const data = {
      kind: 'approval',
      taskId: waiting.id,
      itemId: 'approval:run-9:call-9',
      title: 'Approve?',
      body: '',
    };
    const action = (identifier: string, trigger: unknown, content: unknown) => ({
      actionIdentifier: 'approve',
      notification: { date: 5, request: { identifier, content, trigger } },
    });
    // Drawn by FCM from a message sent around the encryption, our actions borrowed through its category.
    await runTask(action('fcm-1', { type: 'push', remoteMessage: {} }, { dataString: JSON.stringify(data) }));
    // Data that looks like ours, without this install's mark.
    await runTask(action('fake-1', { channelId: 'approval' }, { dataString: JSON.stringify(data) }));
    expect(seen).toEqual([]);
  });

  it('offers no actions before Android 12, which can’t make them wait for the phone to unlock', async () => {
    androidVersion(30);
    const key = holdKey();
    await runTask({ data: seal(key, approvalPush()) });
    expect(
      phone.shade.get(`approval:run-${waiting.number}:call-1`)?.content.categoryIdentifier,
    ).toBeUndefined();
    expect(phone.categories.size).toBe(0);
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
  runOnAndroid();
  const state = AppState.currentState;
  beforeEach(() => {
    AppState.currentState = 'active';
  });
  afterEach(() => {
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

  it('opens a notification’s task when it’s tapped, and only one it drew', async () => {
    signedIn();
    const key = holdKey();
    server.use(...signedInHandlers({ tasks: [waiting] }));
    await renderApp('/');
    await waitFor(() => expect(phone.responseListeners).toHaveLength(1));
    const tap = (notification: unknown) =>
      act(async () => {
        phone.responseListeners[0]?.({
          actionIdentifier: notifications.DEFAULT_ACTION_IDENTIFIER,
          notification,
        });
      });

    // One FCM drew from a message of its own, with the same data: not ours, so nothing opens.
    const id = `approval:run-${waiting.number}:call-1`;
    const data = { kind: 'approval', taskId: waiting.id, itemId: id, title: 'Approve web_search?', body: '' };
    await tap({ date: 1, request: { identifier: 'fcm-1', content: { data }, trigger: { type: 'push' } } });
    await tap({
      date: 2,
      request: { identifier: 'fcm-2', content: { data }, trigger: { channelId: 'approval' } },
    });
    expect(screen.queryByText('Find the papers')).toBeNull();

    // One the app drew.
    AppState.currentState = 'background';
    await runTask({ data: seal(key, approvalPush()) });
    const shown = phone.shade.get(id);
    await tap({ date: 3, request: { identifier: id, content: shown?.content, trigger: shown?.trigger } });
    expect(await screen.findByText('Find the papers')).toBeOnTheScreen();
  });

  it('registers again, as it was, when the server dropped this phone', async () => {
    signedIn();
    const key = holdKey();
    kvStore.setItemSync('push.kinds', JSON.stringify(['approval', 'chief']));
    phone.permission = { granted: true, canAskAgain: true };
    const puts: unknown[] = [];
    server.use(
      http.get(api('/v1/push/device'), () => HttpResponse.json({ configured: true, device: null })),
      http.put(api('/v1/push/device'), async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json(registered(['approval', 'chief']));
      }),
      ...signedInHandlers(),
    );
    await renderApp('/');

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      platform: 'android',
      pushToken: 'fcm-token-1',
      key: key.toString('base64'),
      kinds: ['approval', 'chief'],
    });
  });
});

describe('notification settings', () => {
  runOnAndroid();

  function pushRoutes(configured = true) {
    let mine: MyPush = { configured, device: null };
    const puts: Array<{ platform: string; pushToken: string; key: string; kinds: string[] }> = [];
    const calls: string[] = [];
    const device = registered;
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
