import type { Provider, ProviderModel, ProviderTestResult, Settings } from '@superagent/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { providers } from '../../src/db/schema';
import { type FakeOpenAI, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem } from './helpers';

describe('model providers', () => {
  let system: System;
  let fake: FakeOpenAI;
  let providerId = '';
  const request = (path: string, init?: RequestInit) => system.app.request(path, init);
  const send = (method: string, path: string, body?: unknown) =>
    request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat', 'fake-embed']);
    system = await startTestSystem();
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
  });

  it('stores providers with encrypted secrets and never returns them', async () => {
    const res = await send('POST', '/v1/providers', {
      slug: 'fake',
      name: 'Fake server',
      baseUrl: `${fake.url}/`,
      apiKey: 'sk-test-key-1',
      headers: { 'x-team': 'core' },
    });
    expect(res.status).toBe(201);
    const provider = (await res.json()) as Provider;
    expect(provider).toMatchObject({
      slug: 'fake',
      baseUrl: fake.url,
      hasApiKey: true,
      headerNames: ['x-team'],
      strictJson: false,
      enabled: true,
    });
    expect(JSON.stringify(provider)).not.toContain('sk-test-key-1');
    providerId = provider.id;

    const [row] = await system.db.select().from(providers).where(eq(providers.id, provider.id));
    expect(row?.apiKeyEnc).toMatch(/^v1\./);
    expect(row?.apiKeyEnc).not.toContain('sk-test-key-1');
    expect(row?.headersEnc).not.toContain('core');
  });

  it('rejects duplicate and reserved slugs', async () => {
    const duplicate = await send('POST', '/v1/providers', { slug: 'fake', name: 'Again', baseUrl: fake.url });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'provider_slug_taken' });
    const reserved = await send('POST', '/v1/providers', {
      slug: 'unconfigured',
      name: 'X',
      baseUrl: fake.url,
    });
    expect(reserved.status).toBe(400);
  });

  it('discovers models from GET /models and keeps manual ones', async () => {
    const res = await send('POST', `/v1/providers/${providerId}/refresh-models`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: ProviderModel[] };
    expect(items.map((m) => [m.modelId, m.kind, m.source, m.ref])).toEqual([
      ['fake-chat', 'chat', 'discovered', 'sa/fake/fake-chat'],
      ['fake-embed', 'embedding', 'discovered', 'sa/fake/fake-embed'],
    ]);
    const discovery = fake.requests.find((r) => r.path === '/models');
    expect(discovery?.authorization).toBe('Bearer sk-test-key-1');

    await send('POST', `/v1/providers/${providerId}/models`, { modelId: 'org/hand-added', kind: 'chat' });
    fake.models = ['fake-chat', 'fake-embed', 'brand-new'];
    const refreshed = (await (await send('POST', `/v1/providers/${providerId}/refresh-models`)).json()) as {
      items: ProviderModel[];
    };
    expect(refreshed.items.map((m) => m.modelId)).toEqual([
      'brand-new',
      'fake-chat',
      'fake-embed',
      'org/hand-added',
    ]);

    const removed = await request(
      `/v1/providers/${providerId}/models?modelId=${encodeURIComponent('org/hand-added')}`,
      {
        method: 'DELETE',
        headers: jsonHeaders(),
      },
    );
    expect(removed.status).toBe(204);
  });

  it('passes every connectivity check against a compatible server', async () => {
    const res = await send('POST', `/v1/providers/${providerId}/test`, { embeddingModel: 'fake-embed' });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ProviderTestResult;
    expect(result.checks.map((c) => [c.name, c.ok, c.error])).toEqual([
      ['chat', true, undefined],
      ['stream', true, undefined],
      ['tools', true, undefined],
      ['embedding', true, undefined],
    ]);
    expect(result).toMatchObject({ ok: true, model: 'brand-new', embeddingModel: 'fake-embed' });
    const streamed = fake.requests.find((r) => r.path === '/chat/completions' && r.body?.stream === true);
    expect(streamed?.body?.stream_options).toEqual({ include_usage: true });
  });

  it('applies a rotated key on the next call, without a restart', async () => {
    await send('PATCH', `/v1/providers/${providerId}`, { apiKey: 'sk-rotated-2' });
    const before = fake.requests.length;
    const result = (await (
      await send('POST', `/v1/providers/${providerId}/test`, { model: 'fake-chat' })
    ).json()) as ProviderTestResult;
    expect(result.ok).toBe(true);
    const calls = fake.requests.slice(before).filter((r) => r.path === '/chat/completions');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => r.authorization === 'Bearer sk-rotated-2')).toBe(true);
  });

  it('reports failures without leaking the key', async () => {
    const created = (await (
      await send('POST', '/v1/providers', {
        slug: 'unreachable',
        name: 'Unreachable',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-leak-check-3',
      })
    ).json()) as Provider;
    const res = await send('POST', `/v1/providers/${created.id}/test`, { model: 'any' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect((JSON.parse(text) as ProviderTestResult).ok).toBe(false);
    expect(text).not.toContain('sk-leak-check-3');

    const discovery = await send('POST', `/v1/providers/${created.id}/refresh-models`);
    expect(discovery.status).toBe(502);
    expect(await discovery.text()).not.toContain('sk-leak-check-3');
  });

  describe('settings and the scratch agent', () => {
    it('starts with no model roles and the default timezone', async () => {
      const settings = (await (await send('GET', '/v1/settings')).json()) as Settings;
      expect(settings).toEqual({
        models: { default: null, fast: null, embedding: null },
        timezone: 'Asia/Qatar',
        concurrency: { global: 10, perAgent: 5 },
      });
    });

    it('rejects unknown providers, unknown models and bad timezones', async () => {
      const unknownProvider = await send('PATCH', '/v1/settings', {
        models: { default: { provider: 'nope', model: 'x' } },
      });
      expect(await unknownProvider.json()).toMatchObject({ status: 400, code: 'unknown_provider' });
      const unknownModel = await send('PATCH', '/v1/settings', {
        models: { default: { provider: 'fake', model: 'nope' } },
      });
      expect(await unknownModel.json()).toMatchObject({ status: 400, code: 'unknown_model' });
      const badTimezone = await send('PATCH', '/v1/settings', { timezone: 'Mars/Olympus' });
      expect(badTimezone.status).toBe(400);
    });

    it('explains what to do when the default model role is not set', async () => {
      const res = await send('POST', '/api/agents/scratch/generate', {
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).toContain('No model is configured');
    });

    it('serves the scratch agent through Mastra routes on the default role', async () => {
      const updated = await send('PATCH', '/v1/settings', {
        models: { default: { provider: 'fake', model: 'fake-chat' } },
        timezone: 'Europe/Paris',
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Settings).models.default).toEqual({
        provider: 'fake',
        model: 'fake-chat',
      });

      const generated = await send('POST', '/api/agents/scratch/generate', {
        messages: [{ role: 'user', content: 'hello there' }],
      });
      expect(generated.status).toBe(200);
      expect(((await generated.json()) as { text: string }).text).toContain('pong (fake-chat)');

      const streamed = await send('POST', '/api/agents/scratch/stream', {
        messages: [{ role: 'user', content: 'hello stream' }],
      });
      expect(streamed.status).toBe(200);
      expect(await streamed.text()).toContain('pong (fake-chat)');
    });

    it('keeps settings across restarts of the settings cache', async () => {
      const reloaded = await system.settings.load();
      expect(reloaded.timezone).toBe('Europe/Paris');
      expect(reloaded.models.default).toEqual({ provider: 'fake', model: 'fake-chat' });
    });

    it('refuses to delete a provider that a model role uses', async () => {
      const blocked = await send('DELETE', `/v1/providers/${providerId}`);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: 'provider_in_use' });

      await send('PATCH', '/v1/settings', { models: { default: null } });
      expect((await send('DELETE', `/v1/providers/${providerId}`)).status).toBe(204);
      expect((await send('GET', `/v1/providers/${providerId}`)).status).toBe(404);
    });
  });
});
