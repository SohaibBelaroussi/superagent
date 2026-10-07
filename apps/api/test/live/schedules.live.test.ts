// Live M5 check: the chief turns a request into a schedule, a manual run reaches the lead, and a gated
// tool call waits for the owner's approval before the lead carries on.
// Needs LIVE_LLM_* in .env and `docker compose up -d searxng crawl4ai`. Run with `pnpm test:live`.
import type {
  AttentionItem,
  AttentionList,
  Department,
  Provider,
  Schedule,
  Task,
  TaskEvent,
} from '@superagent/shared';
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

describe.skipIf(!configured)('live schedules and approvals', () => {
  let system: System;
  let research: Department;
  let ops: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;

  async function until<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
    timeoutMs = 240_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  function log(label: string, task: Task, events: TaskEvent[]) {
    console.info(`[live] ${label}: #${task.number} ${task.phase}`);
    console.info(`[live] events: ${events.map((e) => e.type).join(' > ')}`);
    console.info(`[live] result: ${(task.result ?? '').slice(0, 300)}`);
  }

  beforeAll(async () => {
    system = await startTestSystem({
      env: {
        SEARXNG_URL: searxngUrl,
        CRAWL4AI_URL: crawl4aiUrl,
        CRAWL4AI_API_TOKEN: process.env.CRAWL4AI_API_TOKEN ?? '',
        DEFAULT_TIMEZONE: 'Asia/Qatar',
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
    ops = (await (
      await send('POST', '/v1/departments', {
        slug: 'ops',
        name: 'Operations',
        description: 'Checks things.',
      })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'research-lead',
        name: 'Research lead',
        role: 'lead',
        departmentId: research.id,
        description: 'Plans research and reports findings.',
        instructions: 'Answer from what you know in two sentences. Keep results short.',
      },
      {
        key: 'ops-lead',
        name: 'Ops lead',
        role: 'lead',
        departmentId: ops.id,
        description: 'Looks things up on the web.',
        instructions: 'Always call web_search once before you report. Keep results short.',
        tools: [{ key: 'web_search', requireApproval: true }],
      },
    ]) {
      expect((await send('POST', '/v1/agents', agent)).status).toBe(201);
    }
  });

  afterAll(async () => {
    await system?.close();
  });

  it('turns a request into a weekday schedule, and a manual run reaches the lead', async () => {
    const res = await send('POST', '/api/agents/chief/generate', {
      messages: [
        {
          role: 'user',
          content:
            'Every weekday at 9:00, have the research department summarize what is new in AI agent frameworks.',
        },
      ],
      memory: { thread: 'chief:main', resource: 'owner' },
    });
    expect(res.status).toBe(200);
    console.info(`[live] chief: ${((await res.json()) as { text: string }).text.slice(0, 300)}`);
    const schedule = ((await (await send('GET', '/v1/schedules')).json()) as { items: Schedule[] }).items[0];
    console.info(
      `[live] schedule: ${JSON.stringify({ cron: schedule?.cron, timezone: schedule?.timezone, next: schedule?.nextFireAt })}`,
    );
    expect(schedule).toMatchObject({
      createdBy: 'chief',
      timezone: 'Asia/Qatar',
      department: { slug: 'research' },
    });
    expect(schedule?.cron.replace(/\s+/g, ' ')).toMatch(/^0 9 \* \* (1-5|MON-FRI)$/i);

    const run = (await (await send('POST', `/v1/schedules/${schedule?.id}/run`)).json()) as Task;
    const task = await until(
      () => getTask(run.id),
      (t) => SETTLED.includes(t.phase),
      'the scheduled task settles',
    );
    const events = await eventsOf(run.id);
    log('scheduled task', task, events);
    expect(events.map((e) => e.type)).toContain('reported');
  }, 300_000);

  it('waits for the owner before a gated search, then carries on', async () => {
    const created = (await (
      await send('POST', '/v1/tasks', {
        departmentId: ops.id,
        title: 'Latest Mastra release',
        brief: 'Find the latest release of the Mastra framework. Search the web for it.',
      })
    ).json()) as Task;
    await until(
      () => eventsOf(created.id),
      (events) => events.some((e) => e.type === 'approval_requested'),
      'the approval request',
    );
    expect((await getTask(created.id)).phase).toBe('waiting');
    // Approve each gated call (the model may search more than once) until the task settles.
    let approvals = 0;
    const task = await until(
      async () => {
        const items = ((await (await send('GET', '/v1/attention')).json()) as AttentionList).items;
        for (const item of items.filter(
          (i): i is AttentionItem => i.kind === 'approval' && i.taskId === created.id,
        )) {
          console.info(`[live] approving ${item.tool} ${JSON.stringify(item.args)}`);
          expect((await send('POST', `/v1/attention/${encodeURIComponent(item.id)}/approve`)).status).toBe(
            200,
          );
          approvals += 1;
        }
        return getTask(created.id);
      },
      (t) => approvals > 0 && t.phase !== 'waiting' && SETTLED.includes(t.phase),
      'the approved task settles',
    );
    const events = await eventsOf(created.id);
    log('approved task', task, events);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['approval_requested', 'approval_decided']),
    );
  }, 300_000);
});
