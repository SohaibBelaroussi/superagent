import { createDecipheriv, randomBytes } from 'node:crypto';
import type { CreatedToken, MyPush, PushDevice, PushPayload, PushStatus, Task } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeFcm, startFakeFcm } from '../support/fake-fcm';
import { authHeader, jsonHeaders, startTestSystem } from './helpers';

/** What a phone does with a push: decrypts it with its key (the same AES-256-GCM as the app). */
function decrypt(keyBase64: string, data: Record<string, string>): PushPayload {
  expect(data.v).toBe('1');
  const sealed = Buffer.from(data.c ?? '', 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from('superagent-push-v1'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const text = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
  return JSON.parse(text.toString('utf8')) as PushPayload;
}

describe('push notifications', () => {
  let system: System;
  let fcm: FakeFcm;
  const request = (path: string, init?: RequestInit) => system.app.request(path, init);
  const send = (method: string, path: string, body?: unknown, token?: string) =>
    request(path, {
      method,
      headers: jsonHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const deviceToken = async (name: string) =>
    ((await (await send('POST', '/v1/tokens', { name })).json()) as CreatedToken).token;
  const register = async (token: string, pushToken: string, kinds: string[]) => {
    const key = randomBytes(32).toString('base64');
    const res = await send('PUT', '/v1/push/device', { platform: 'android', pushToken, key, kinds }, token);
    return { res, key };
  };
  let task: Task;

  beforeAll(async () => {
    fcm = await startFakeFcm();
    system = await startTestSystem({ env: { PUSH_FCM_URL: fcm.fcmUrl, PUSH_OAUTH_URL: fcm.oauthUrl } });
    await send('POST', '/v1/departments', { slug: 'research', name: 'Research' });
    const departments = (await (await request('/v1/departments', { headers: authHeader() })).json()) as {
      items: Array<{ id: string }>;
    };
    task = (await (
      await send('POST', '/v1/tasks', {
        departmentId: departments.items[0]?.id,
        title: 'Find the papers',
        brief: 'Three recent ones.',
        dispatch: false,
      })
    ).json()) as Task;
  });
  afterAll(async () => {
    await system?.close();
    await fcm?.close();
  });

  it('takes a Firebase service account Google accepts, and never shows it', async () => {
    const refused = await send('PUT', '/v1/push/config', { serviceAccount: fcm.strangerAccount() });
    expect(refused.status).toBe(422);
    const notJson = await send('PUT', '/v1/push/config', { serviceAccount: '{"type":"user"}' });
    expect(notJson.status).toBe(400);

    const phone = await deviceToken('App: Pixel 9');
    expect(
      (await send('PUT', '/v1/push/config', { serviceAccount: fcm.serviceAccount() }, phone)).status,
    ).toBe(403);

    const accepted = await send('PUT', '/v1/push/config', { serviceAccount: fcm.serviceAccount() });
    expect(accepted.status).toBe(200);
    const status = (await accepted.json()) as PushStatus;
    expect(status).toMatchObject({ configured: true, projectId: 'superagent-test' });
    const listed = await request('/v1/push', { headers: authHeader() });
    expect(JSON.stringify(await listed.json())).not.toContain('PRIVATE KEY');
  });

  it('registers a phone with its own key, and sends it an encrypted test', async () => {
    const phone = await deviceToken('App: Pixel 9, Android 16');
    // The admin token has no device of its own.
    expect((await register(undefined as unknown as string, 'fcm-admin', ['approval'])).res.status).toBe(403);
    const { res, key } = await register(phone, 'fcm-phone-1', ['approval', 'review', 'chief']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PushDevice).tokenName).toBe('App: Pixel 9, Android 16');

    const mine = (await (await request('/v1/push/device', { headers: authHeader(phone) })).json()) as MyPush;
    expect(mine).toMatchObject({ configured: true, device: { kinds: ['approval', 'review', 'chief'] } });

    const before = fcm.messages.length;
    expect((await send('POST', '/v1/push/device/test', {}, phone)).status).toBe(204);
    const message = fcm.messages[before];
    expect(message).toMatchObject({ projectId: 'superagent-test', token: 'fcm-phone-1' });
    expect(Object.keys(message?.data ?? {}).sort()).toEqual(['c', 'v']);
    expect(decrypt(key, message?.data ?? {})).toMatchObject({ kind: 'test', body: 'Notifications work.' });
  });

  it('tells each phone what it asked for: an approval to give, the chief’s answer', async () => {
    const all = await register(await deviceToken('App: all'), 'fcm-all', ['approval', 'question', 'chief']);
    const quiet = await register(await deviceToken('App: reviews only'), 'fcm-quiet', ['review']);
    expect(all.res.status).toBe(200);
    expect(quiet.res.status).toBe(200);
    const before = fcm.messages.length;

    await system.tasks.note(task.id, 'approval_requested', 'agent:research-lead', {
      tool: 'web_search',
      args: { query: 'agent memory' },
      runId: 'run-1',
      toolCallId: 'call-1',
    });
    await vi.waitFor(() => expect(fcm.messages.slice(before).map((m) => m.token)).toContain('fcm-all'));
    const approval = fcm.messages.slice(before).find((m) => m.token === 'fcm-all');
    expect(decrypt(all.key, approval?.data ?? {})).toMatchObject({
      kind: 'approval',
      title: 'Approve web_search?',
      body: `#${task.number} Find the papers`,
      taskId: task.id,
      itemId: 'approval:run-1:call-1',
    });
    // Nothing reaches the phone that only wants reviews; FCM sees only ciphertext.
    expect(fcm.messages.slice(before).map((m) => m.token)).not.toContain('fcm-quiet');
    expect(JSON.stringify(fcm.messages)).not.toContain('web_search');

    const mark = fcm.messages.length;
    system.push.chiefAnswered('Two tasks are running.');
    await vi.waitFor(() => expect(fcm.messages.slice(mark).map((m) => m.token)).toContain('fcm-all'));
    const answer = fcm.messages.slice(mark).find((m) => m.token === 'fcm-all');
    expect(decrypt(all.key, answer?.data ?? {})).toMatchObject({
      kind: 'chief',
      body: 'Two tasks are running.',
    });
  });

  it('forgets a phone whose token is revoked, or that FCM no longer knows', async () => {
    const phone = await deviceToken('App: to revoke');
    const gone = await deviceToken('App: uninstalled');
    await register(phone, 'fcm-revoked', ['approval']);
    await register(gone, 'fcm-gone', ['approval']);
    const me = (await (await request('/v1/me', { headers: authHeader(phone) })).json()) as {
      token: { id: string };
    };
    expect((await send('DELETE', `/v1/tokens/${me.token.id}`)).status).toBe(204);
    fcm.gone.add('fcm-gone');

    const before = fcm.messages.length;
    await system.tasks.note(task.id, 'approval_requested', 'agent:research-lead', {
      tool: 'fetch_page',
      runId: 'run-2',
      toolCallId: 'call-2',
    });
    await vi.waitFor(async () => {
      const status = (await (await request('/v1/push', { headers: authHeader() })).json()) as PushStatus;
      const names = status.devices.map((device) => device.tokenName);
      expect(names).not.toContain('App: to revoke');
      expect(names).not.toContain('App: uninstalled');
    });
    expect(fcm.messages.slice(before).map((m) => m.token)).not.toContain('fcm-revoked');
  });

  it('stops this device’s pushes when it asks', async () => {
    const phone = await deviceToken('App: leaving');
    await register(phone, 'fcm-leaving', ['approval']);
    expect((await send('DELETE', '/v1/push/device', undefined, phone)).status).toBe(204);
    const mine = (await (await request('/v1/push/device', { headers: authHeader(phone) })).json()) as MyPush;
    expect(mine.device).toBeNull();
  });
});
