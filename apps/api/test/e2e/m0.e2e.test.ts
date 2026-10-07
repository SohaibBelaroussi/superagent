// M0 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
import type { CreatedToken, Me } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const ADMIN_TOKEN = process.env.SUPERAGENT_ADMIN_TOKEN ?? '';
const auth = (token = ADMIN_TOKEN) => ({ Authorization: `Bearer ${token}` });

describe(`M0 against ${BASE_URL}`, () => {
  it('is healthy and ready', async () => {
    expect((await fetch(`${BASE_URL}/health`)).status).toBe(200);
    const ready = await fetch(`${BASE_URL}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });
  });

  it('rejects requests without a token', async () => {
    expect((await fetch(`${BASE_URL}/v1/me`)).status).toBe(401);
    expect((await fetch(`${BASE_URL}/api/agents`)).status).toBe(401);
    expect((await fetch(`${BASE_URL}/v1/openapi.json`)).status).toBe(401);
  });

  it('accepts the admin token', async () => {
    const res = await fetch(`${BASE_URL}/v1/me`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).id).toBe('owner');
  });

  it('runs the device token lifecycle', async () => {
    const created = await fetch(`${BASE_URL}/v1/tokens`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e' }),
    });
    expect(created.status).toBe(201);
    const { token, record } = (await created.json()) as CreatedToken;
    expect((await fetch(`${BASE_URL}/v1/me`, { headers: auth(token) })).status).toBe(200);
    const revoked = await fetch(`${BASE_URL}/v1/tokens/${record.id}`, { method: 'DELETE', headers: auth() });
    expect(revoked.status).toBe(204);
    expect((await fetch(`${BASE_URL}/v1/me`, { headers: auth(token) })).status).toBe(401);
  });
});
