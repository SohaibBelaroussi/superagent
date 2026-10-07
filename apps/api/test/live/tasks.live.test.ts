// Live M3 check: a real model runs a task from dispatch to report, and the chief assigns one itself.
// Needs LIVE_LLM_* in .env and `docker compose up -d searxng crawl4ai`. Run with `pnpm test:live`.
import type { Department, Provider, Task, TaskEvent } from '@superagent/shared';
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
const SETTLED: ReadonlyArray<Task['phase']> = ['review', 'done', 'waiting', 'failed', 'cancelled'];

describe.skipIf(!configured)('live task ledger', () => {
  let system: System;
  let research: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;

  async function settle(id: string, timeoutMs = 240_000): Promise<{ task: Task; events: TaskEvent[] }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await getTask(id);
      const events = await eventsOf(id);
      // Settled, and the chief has heard about it.
      if (SETTLED.includes(task.phase) && events.some((e) => e.type === 'chief_notified'))
        return { task, events };
      if (Date.now() > deadline) throw new Error(`Task #${task.number} still ${task.phase}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  function log(label: string, task: Task, events: TaskEvent[]) {
    console.info(`[live] ${label}: #${task.number} ${task.phase}, progress ${task.progress}`);
    console.info(`[live] events: ${events.map((e) => e.type).join(' > ')}`);
    console.info(`[live] result: ${(task.result ?? '').slice(0, 400)}`);
  }

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
    research = (await (
      await send('POST', '/v1/departments', {
        slug: 'research',
        name: 'Research',
        description: 'Web research.',
      })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'research-lead',
        name: 'Research lead',
        role: 'lead',
        description: 'Plans research and reviews findings.',
        instructions: 'Delegate web lookups to the web researcher. Keep results short.',
      },
      {
        key: 'web-researcher',
        name: 'Web researcher',
        role: 'specialist',
        description: 'Searches the web and reads pages; returns facts with source URLs.',
        instructions: 'Use web_search first, then fetch_page on the best result if needed. Keep it short.',
        tools: [{ key: 'web_search' }, { key: 'fetch_page' }],
      },
    ]) {
      expect((await send('POST', '/v1/agents', { ...agent, departmentId: research.id })).status).toBe(201);
    }
  });

  afterAll(async () => {
    await system?.close();
  });

  it('runs an owner task from dispatch to the report', async () => {
    const res = await send('POST', '/v1/tasks', {
      departmentId: research.id,
      title: 'What is Mastra?',
      brief: 'Find out what the Mastra framework is. One or two sentences, with one source URL.',
    });
    expect(res.status).toBe(201);
    const { task, events } = await settle(((await res.json()) as Task).id);
    log('owner task', task, events);
    expect(events.map((e) => e.type)).toContain('reported');
    expect(task.phase).toBe('review');
    expect(task.result?.length ?? 0).toBeGreaterThan(0);
  }, 300_000);

  it('lets the chief assign a task that the lead reports back on', async () => {
    const res = await send('POST', '/api/agents/chief/generate', {
      messages: [
        {
          role: 'user',
          content:
            'Please have the research department find out who maintains the Mastra framework, with one source. Assign it as a task.',
        },
      ],
      memory: { thread: 'chief:main', resource: 'owner' },
    });
    expect(res.status).toBe(200);
    console.info(`[live] chief: ${((await res.json()) as { text: string }).text.slice(0, 300)}`);
    const assigned = (
      (await (await send('GET', '/v1/tasks?limit=5')).json()) as { items: Task[] }
    ).items.find((t) => t.source === 'chief');
    expect(assigned, 'the chief created a task').toBeDefined();
    const { task, events } = await settle(assigned?.id ?? '');
    log('chief task', task, events);
    expect(events.map((e) => e.type)).toContain('reported');
  }, 300_000);
});
