// M1 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// Provider CRUD and settings only: connectivity checks run in the integration and live suites.
import type { Provider, Settings } from '@superagent/shared';
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

describe(`M1 against ${BASE_URL}`, () => {
  it('manages a provider without ever returning its key', async () => {
    const slug = `e2e-${Date.now().toString(36)}`;
    const created = await call('POST', '/v1/providers', {
      slug,
      name: 'E2E provider',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-e2e-secret',
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as Provider;
    expect(provider).toMatchObject({ slug, hasApiKey: true });

    const listed = await (await call('GET', '/v1/providers')).text();
    expect(listed).toContain(slug);
    expect(listed).not.toContain('sk-e2e-secret');

    const patched = (await (
      await call('PATCH', `/v1/providers/${provider.id}`, { apiKey: null })
    ).json()) as Provider;
    expect(patched.hasApiKey).toBe(false);

    expect((await call('DELETE', `/v1/providers/${provider.id}`)).status).toBe(204);
  });

  it('serves settings', async () => {
    const res = await call('GET', '/v1/settings');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Settings).timezone).toBeTruthy();
  });
});
