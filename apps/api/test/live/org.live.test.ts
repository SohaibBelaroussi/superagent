// Live M2 check: a real model as lead and specialist, with the real SearXNG and Crawl4AI from compose.
// Needs LIVE_LLM_* in .env and `docker compose up -d searxng crawl4ai`. Run with `pnpm test:live`.
import type { AgentDefinition, Department, Provider } from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { loadDotEnv } from '../../src/env';
import { jsonHeaders, startTestSystem } from '../int/helpers';

loadDotEnv();
const live = {
  baseUrl: process.env.LIVE_LLM_BASE_URL ?? '',
  apiKey: process.env.LIVE_LLM_API_KEY ?? '',
  model: process.env.LIVE_LLM_MODEL ?? '',
};
const searxngUrl = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';
const crawl4aiUrl = process.env.CRAWL4AI_URL ?? 'http://127.0.0.1:11235';
const configured = Boolean(live.baseUrl && live.apiKey && live.model && process.env.CRAWL4AI_API_TOKEN);

describe.skipIf(!configured)('live research department', () => {
  let system: System;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    system = await startTestSystem({
      env: {
        SEARXNG_URL: searxngUrl,
        CRAWL4AI_URL: crawl4aiUrl,
        CRAWL4AI_API_TOKEN: process.env.CRAWL4AI_API_TOKEN ?? '',
      },
    });
    const provider = (await (
      await send('POST', '/v1/providers', {
        slug: 'live',
        name: 'Live',
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
      })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'live', model: live.model } } });
    const department = (await (
      await send('POST', '/v1/departments', {
        slug: 'research',
        name: 'Research',
        description: 'Web research.',
      })
    ).json()) as Department;
    const agents = [
      {
        key: 'research-lead',
        name: 'Research lead',
        role: 'lead',
        description: 'Plans research and reviews findings.',
        instructions: 'Always delegate web lookups to the web researcher. Answer in at most three sentences.',
        tools: [],
      },
      {
        key: 'web-researcher',
        name: 'Web researcher',
        role: 'specialist',
        description: 'Searches the web and reads pages; returns facts with source URLs.',
        instructions: 'Use web_search first, then fetch_page on the best result if needed. Keep it short.',
        tools: [{ key: 'web_search' }, { key: 'fetch_page' }],
      },
    ];
    for (const agent of agents) {
      const res = await send('POST', '/v1/agents', { ...agent, departmentId: department.id });
      expect(res.status, ((await res.clone().json()) as AgentDefinition).key).toBe(201);
    }
  });

  afterAll(async () => {
    await system?.close();
  });

  it('answers a research question by delegating to the specialist', async () => {
    const res = await send('POST', '/api/agents/research-lead/generate', {
      messages: [{ role: 'user', content: 'What is the Mastra framework? Give one source URL.' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; steps?: Array<{ toolCalls?: Array<unknown> }> };
    const delegated = JSON.stringify(body).includes('agent-web-researcher');
    console.info(`[live] delegated to the specialist: ${delegated}`);
    console.info(`[live] answer: ${body.text.slice(0, 400)}`);
    expect(body.text.length).toBeGreaterThan(0);
    expect(delegated).toBe(true);
  });
});
