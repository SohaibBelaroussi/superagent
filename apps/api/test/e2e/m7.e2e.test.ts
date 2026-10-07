// M7 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// The packaged runner starts a browser from the browser image, on the browsers network that the egress
// proxy creates. Agents browsing are covered by the integration and live suites (they need a model).
import { request } from 'node:http';
import type {
  BrowserIdentity,
  BrowserSession,
  BrowserSessionList,
  Department,
  Task,
} from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const headers = {
  Authorization: `Bearer ${process.env.SUPERAGENT_ADMIN_TOKEN ?? ''}`,
  'content-type': 'application/json',
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The status a WebSocket upgrade gets without a token. */
function upgradeStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${BASE_URL}${path}`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      reject(new Error('upgraded without a token'));
    });
    req.on('error', reject);
    req.end();
  });
}

describe(`M7 against ${BASE_URL}`, () => {
  it('signs an identity in through a browser the runner starts, then deletes it', async () => {
    const name = `e2e-${Date.now().toString(36)}`;
    const created = await call('POST', '/v1/browser-identities', { name, description: 'E2E' });
    expect(created.status, await created.clone().text()).toBe(201);
    const identity = (await created.json()) as BrowserIdentity;
    expect(identity).toMatchObject({ name, description: 'E2E', holder: null });
    expect((await call('POST', '/v1/browser-identities', { name })).status).toBe(409);
    expect((await call('POST', '/v1/browser-identities', { name: 'Not A Slug' })).status).toBe(400);

    // The owner's sign-in session: Chromium in its hardened container, reached through the runner.
    const opened = await call('POST', `/v1/browser-identities/${identity.id}/session`);
    expect(opened.status, await opened.clone().text()).toBe(201);
    expect((await opened.json()) as BrowserSession).toMatchObject({ kind: 'sign-in', identity: name });
    const held = (await (
      await call('GET', `/v1/browser-identities/${identity.id}`)
    ).json()) as BrowserIdentity;
    expect(held.holder).toMatchObject({ kind: 'owner', taskId: null });
    const browsers = (await (await call('GET', '/v1/browsers')).json()) as BrowserSessionList;
    expect(browsers.items.some((b) => b.kind === 'sign-in' && b.identity === name)).toBe(true);
    // In use: it can't be deleted.
    expect((await call('DELETE', `/v1/browser-identities/${identity.id}`)).status).toBe(409);

    expect((await call('DELETE', `/v1/browser-identities/${identity.id}/session`)).status).toBe(204);
    expect((await call('DELETE', `/v1/browser-identities/${identity.id}/session`)).status).toBe(404);
    expect((await call('DELETE', `/v1/browser-identities/${identity.id}`)).status).toBe(204);
    expect((await call('GET', `/v1/browser-identities/${identity.id}`)).status).toBe(404);
  }, 120_000);

  it("keeps tasks' browsers and live views behind the token", async () => {
    const marker = `e2e-${Date.now().toString(36)}`;
    const department = (await (
      await call('POST', '/v1/departments', { slug: marker, name: `E2E ${marker}` })
    ).json()) as Department;
    const task = (await (
      await call('POST', '/v1/tasks', {
        departmentId: department.id,
        title: 'No browser',
        brief: 'Nothing yet.',
        dispatch: false,
      })
    ).json()) as Task;
    expect((await call('GET', `/v1/tasks/${task.id}/browser`)).status).toBe(404);
    expect((await call('DELETE', `/v1/tasks/${task.id}/browser`)).status).toBe(404);
    expect(await upgradeStatus(`/v1/tasks/${task.id}/browser/stream`)).toBe(401);
    expect(await upgradeStatus(`/v1/browser-identities/${crypto.randomUUID()}/stream`)).toBe(401);
    expect((await fetch(`${BASE_URL}/v1/browsers`)).status).toBe(401);
    // An agent's browser grant names identities that exist.
    const agent = await call('POST', '/v1/agents', {
      key: `${marker}-surfer`,
      name: 'E2E surfer',
      role: 'specialist',
      departmentId: department.id,
      description: 'Browses.',
      instructions: 'Browse.',
      tools: [{ key: 'browser', identity: `${marker}-missing` }],
    });
    expect(agent.status).toBe(400);
    expect(await agent.json()).toMatchObject({ code: 'unknown_identity' });
  });
});
