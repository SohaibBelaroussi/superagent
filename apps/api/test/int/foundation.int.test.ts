import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import type { CreatedToken, Me, TokenList } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { scripted } from '../support/mock-model';
import { authHeader, jsonHeaders, startTestSystem } from './helpers';

const PUBLIC_OUTSIDE_PRODUCTION = new Set(['/v1/openapi.json', '/v1/docs']);
const SAMPLE_ID = '0192f1a0-0000-7000-8000-000000000000';

/** Every concrete /v1 route the app registered, with path params filled in. */
function v1Routes(system: System): Array<{ method: string; path: string }> {
  const unique = new Map<string, { method: string; path: string }>();
  for (const route of system.app.routes) {
    if (!route.path.startsWith('/v1/') || route.method === 'ALL' || route.path.includes('*')) continue;
    const path = route.path.replace(/:[A-Za-z_]+/g, SAMPLE_ID);
    unique.set(`${route.method} ${path}`, { method: route.method, path });
  }
  return [...unique.values()];
}

describe('foundation', () => {
  let system: System;
  const request = (path: string, init?: RequestInit) => system.app.request(path, init);

  beforeAll(async () => {
    const echo = new Agent({
      id: 'echo',
      name: 'Echo',
      instructions: 'Reply with pong.',
      model: scripted([{ text: 'pong' }]),
    });
    system = await startTestSystem({ agents: { echo } });
  });

  afterAll(async () => {
    await system?.close();
  });

  describe('health', () => {
    it('serves /health without a token', async () => {
      const res = await request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('reports database readiness on /ready', async () => {
      const res = await request('/ready');
      expect(res.status).toBe(200);
      // Nothing is sealed in a fresh database: any encryption key opens it.
      expect(await res.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', encryptionKey: 'empty' },
      });
    });
  });

  describe('authentication', () => {
    it('rejects every /v1 route without a token', async () => {
      const routes = v1Routes(system).filter((r) => !PUBLIC_OUTSIDE_PRODUCTION.has(r.path));
      expect(routes.length).toBeGreaterThanOrEqual(4);
      for (const route of routes) {
        const res = await request(route.path, { method: route.method });
        expect(res.status, `${route.method} ${route.path}`).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
      }
    });

    it('rejects unknown /v1 paths without a token instead of revealing a 404', async () => {
      expect((await request('/v1/does-not-exist')).status).toBe(401);
      expect((await request('/v1/does-not-exist', { headers: authHeader() })).status).toBe(404);
    });

    it('accepts the admin token', async () => {
      const res = await request('/v1/me', { headers: authHeader() });
      expect(res.status).toBe(200);
      expect((await res.json()) as Me).toEqual({
        id: 'owner',
        name: 'Owner',
        token: { id: 'admin', name: 'admin (env)' },
      });
    });

    it('rejects a wrong token', async () => {
      const res = await request('/v1/me', { headers: authHeader(`sa_${'w'.repeat(43)}`) });
      expect(res.status).toBe(401);
    });

    it('accepts the token as ?apiKey= for EventSource clients', async () => {
      const res = await request(
        `/v1/me?apiKey=${encodeURIComponent(authHeader().Authorization?.slice(7) ?? '')}`,
      );
      expect(res.status).toBe(200);
    });

    it('protects Mastra routes under /api', async () => {
      expect((await request('/api/agents')).status).toBe(401);
      const res = await request('/api/agents', { headers: authHeader() });
      expect(res.status).toBe(200);
      expect(Object.keys((await res.json()) as object)).toContain('echo');
    });
  });

  describe('tokens', () => {
    it('creates, lists, uses and revokes a device token', async () => {
      const created = await request('/v1/tokens', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'phone' }),
      });
      expect(created.status).toBe(201);
      const { token, record } = (await created.json()) as CreatedToken;
      expect(token).toMatch(/^sa_[A-Za-z0-9_-]{43}$/);
      expect(record).toMatchObject({ name: 'phone', prefix: token.slice(0, 9), revokedAt: null });

      const me = await request('/v1/me', { headers: authHeader(token) });
      expect(me.status).toBe(200);
      expect(((await me.json()) as Me).token).toEqual({ id: record.id, name: 'phone' });

      const listed = await request('/v1/tokens', { headers: authHeader() });
      const listBody = (await listed.json()) as TokenList;
      expect(listBody.items.map((t) => t.id)).toContain(record.id);
      expect(JSON.stringify(listBody)).not.toContain(token);

      const revoked = await request(`/v1/tokens/${record.id}`, { method: 'DELETE', headers: authHeader() });
      expect(revoked.status).toBe(204);
      expect((await request('/v1/me', { headers: authHeader(token) })).status).toBe(401);

      const again = await request(`/v1/tokens/${record.id}`, { method: 'DELETE', headers: authHeader() });
      expect(again.status).toBe(204);
    });

    it('returns 404 when revoking an unknown token', async () => {
      const res = await request(`/v1/tokens/${SAMPLE_ID}`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ status: 404, code: 'token_not_found' });
    });

    it('validates request bodies and answers with problem+json', async () => {
      const res = await request('/v1/tokens', { method: 'POST', headers: jsonHeaders(), body: '{}' });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ code: 'validation_failed', errors: [{ path: 'name' }] });
    });

    it('validates path parameters', async () => {
      const res = await request('/v1/tokens/not-a-uuid', { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(400);
    });

    it('lets only the admin token manage tokens; a device token may revoke itself', async () => {
      const create = async (name: string) => {
        const res = await request('/v1/tokens', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name }),
        });
        return (await res.json()) as CreatedToken;
      };
      const laptop = await create('laptop');
      const phone = await create('phone');

      const listAsDevice = await request('/v1/tokens', { headers: authHeader(laptop.token) });
      expect(listAsDevice.status).toBe(403);
      expect(await listAsDevice.json()).toMatchObject({ code: 'admin_token_required' });

      const mintAsDevice = await request('/v1/tokens', {
        method: 'POST',
        headers: jsonHeaders(laptop.token),
        body: JSON.stringify({ name: 'sneaky' }),
      });
      expect(mintAsDevice.status).toBe(403);

      const revokeOther = await request(`/v1/tokens/${phone.record.id}`, {
        method: 'DELETE',
        headers: authHeader(laptop.token),
      });
      expect(revokeOther.status).toBe(403);
      expect((await request('/v1/me', { headers: authHeader(phone.token) })).status).toBe(200);

      const signOut = await request(`/v1/tokens/${laptop.record.id}`, {
        method: 'DELETE',
        headers: authHeader(laptop.token),
      });
      expect(signOut.status).toBe(204);
      expect((await request('/v1/me', { headers: authHeader(laptop.token) })).status).toBe(401);
    });
  });

  describe('limits and resilience', () => {
    it('rejects oversized bodies with 413 before auth runs', async () => {
      const body = 'x'.repeat(5 * 1024 * 1024);
      const headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
      const unauthenticated = await request('/v1/tokens', { method: 'POST', headers, body });
      expect(unauthenticated.status).toBe(413);
      expect(unauthenticated.headers.get('content-type')).toContain('application/problem+json');
      const toMastra = await request('/api/agents/echo/generate', { method: 'POST', headers, body });
      expect(toMastra.status).toBe(413);
    });

    it('survives an idle Postgres client error instead of crashing', () => {
      expect(() => system.pool.emit('error', new Error('terminating connection'))).not.toThrow();
    });
  });

  describe('Mastra runtime', () => {
    it('answers through /api/agents/:id/generate with a scripted model', async () => {
      const res = await request('/api/agents/echo/generate', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { text: string }).text).toBe('pong');
    });

    it('stores threads whose ids contain colons (task:<id>, dept:<slug>)', async () => {
      const storage = system.mastra.getStorage();
      if (!storage) throw new Error('Mastra has no storage');
      const memory = new Memory({ storage });
      await memory.createThread({
        threadId: 'task:0192f1a0',
        resourceId: 'dept:research',
        title: 'Colon check',
        metadata: { taskId: '0192f1a0' },
      });
      const thread = await memory.getThreadById({ threadId: 'task:0192f1a0' });
      expect(thread).toMatchObject({ resourceId: 'dept:research', metadata: { taskId: '0192f1a0' } });
    });
  });

  describe('API docs', () => {
    it('serves the OpenAPI document with our routes outside production', async () => {
      const res = await request('/v1/openapi.json');
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { paths: Record<string, unknown> };
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/me', '/tokens', '/tokens/{id}']));
    });
  });
});

describe('foundation in production mode', () => {
  let system: System;

  beforeAll(async () => {
    system = await startTestSystem({ env: { NODE_ENV: 'production' } });
  });

  afterAll(async () => {
    await system?.close();
  });

  it('requires a token for the OpenAPI document and hides the docs UI', async () => {
    expect((await system.app.request('/v1/openapi.json')).status).toBe(401);
    expect((await system.app.request('/v1/openapi.json', { headers: authHeader() })).status).toBe(200);
    expect((await system.app.request('/v1/docs', { headers: authHeader() })).status).toBe(404);
  });
});
