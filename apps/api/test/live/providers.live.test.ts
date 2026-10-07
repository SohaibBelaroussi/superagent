// Live checks against a real OpenAI-compatible provider configured in the root .env:
//   LIVE_LLM_BASE_URL, LIVE_LLM_API_KEY, LIVE_LLM_MODEL, optional LIVE_LLM_EMBEDDING_MODEL.
// Run with `pnpm test:live`. Not part of `pnpm check` or CI (needs your key and network).
import type { Provider, ProviderModel, ProviderTestResult } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { loadDotEnv } from '../../src/env';
import { jsonHeaders, startTestSystem } from '../int/helpers';

loadDotEnv();
const live = {
  baseUrl: process.env.LIVE_LLM_BASE_URL ?? '',
  apiKey: process.env.LIVE_LLM_API_KEY ?? '',
  model: process.env.LIVE_LLM_MODEL ?? '',
  embeddingModel: process.env.LIVE_LLM_EMBEDDING_MODEL || undefined,
};
const configured = Boolean(live.baseUrl && live.apiKey && live.model);

describe.skipIf(!configured)('live provider', () => {
  let system: System;
  let provider: Provider;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    system = await startTestSystem();
    const res = await send('POST', '/v1/providers', {
      slug: 'live',
      name: 'Live provider',
      baseUrl: live.baseUrl,
      apiKey: live.apiKey,
    });
    expect(res.status).toBe(201);
    provider = (await res.json()) as Provider;
  });

  afterAll(async () => {
    await system?.close();
  });

  it('lists models (or accepts a manually added one)', async () => {
    const res = await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    if (res.status === 200) {
      const { items } = (await res.json()) as { items: ProviderModel[] };
      console.info(`[live] discovered ${items.length} models: ${items.map((m) => m.modelId).join(', ')}`);
    } else {
      console.info(`[live] model discovery failed (${res.status}): ${await res.text()}`);
    }
    await send('POST', `/v1/providers/${provider.id}/models`, { modelId: live.model, kind: 'chat' });
    if (live.embeddingModel) {
      await send('POST', `/v1/providers/${provider.id}/models`, {
        modelId: live.embeddingModel,
        kind: 'embedding',
      });
    }
  });

  it('passes the connectivity checks', async () => {
    const res = await send('POST', `/v1/providers/${provider.id}/test`, {
      model: live.model,
      embeddingModel: live.embeddingModel,
    });
    const result = (await res.json()) as ProviderTestResult;
    for (const check of result.checks) {
      console.info(
        `[live] ${check.name}: ${check.ok ? 'ok' : 'FAILED'} (${check.ms} ms) ${check.detail ?? check.error ?? ''}`,
      );
    }
    expect(JSON.stringify(result)).not.toContain(live.apiKey);
    expect(result.checks.find((c) => c.name === 'chat')?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'stream')?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'tools')?.ok).toBe(true);
  });

  it('answers through the scratch agent on the default role', async () => {
    const updated = await send('PATCH', '/v1/settings', {
      models: { default: { provider: 'live', model: live.model } },
    });
    expect(updated.status).toBe(200);
    const res = await send('POST', '/api/agents/scratch/generate', {
      messages: [{ role: 'user', content: 'In one short sentence: what is 2 + 2?' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; usage?: { totalTokens?: number } };
    console.info(
      `[live] scratch agent: "${body.text.slice(0, 120)}" (${body.usage?.totalTokens ?? '?'} tokens)`,
    );
    expect(body.text.length).toBeGreaterThan(0);
  });
});
