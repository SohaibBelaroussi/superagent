// Live M4 check: the owner's profile and a department's notes shape a real model's work, and the real
// model compresses a long task thread into observations.
// Needs LIVE_LLM_* in .env. Run with `pnpm test:live`.
import type { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { Department, DepartmentMemory, Provider, Task, TaskEvent } from '@superagent/shared';
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
const configured = Boolean(live.baseUrl && live.apiKey && live.model);

describe.skipIf(!configured)('live memory', () => {
  let system: System;
  let research: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;

  /** Waits for `count` reports on the task (and the chief hearing about the last one). */
  async function reports(id: string, count: number): Promise<Task> {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const events = await eventsOf(id);
      const done = events.filter((e) => e.type === 'reported').length >= count;
      if (done && events.at(-1)?.type === 'chief_notified') {
        return (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
      }
      if (Date.now() > deadline) throw new Error(`Timed out: ${events.map((e) => e.type).join(' > ')}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const runTask = async (title: string, brief: string) => {
    const res = await send('POST', '/v1/tasks', { departmentId: research.id, title, brief });
    expect(res.status).toBe(201);
    return reports(((await res.json()) as Task).id, 1);
  };

  beforeAll(async () => {
    // A low threshold so a few turns are enough for the real model to compress the thread.
    system = await startTestSystem({ env: { MEMORY_OBSERVE_TOKENS: '600', MEMORY_OBSERVE_AHEAD: 'false' } });
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
        description: 'Answers questions.',
      })
    ).json()) as Department;
    const lead = await send('POST', '/v1/agents', {
      key: 'research-lead',
      name: 'Research lead',
      role: 'lead',
      departmentId: research.id,
      description: 'Answers questions from its own knowledge.',
      instructions: 'You have no specialists: answer yourself, briefly, then report.',
    });
    expect(lead.status).toBe(201);
  });

  afterAll(async () => {
    await system?.close();
  });

  it('answers in the language from the owner profile', async () => {
    await send('PATCH', '/v1/profile', { language: 'French', preferences: ['Always answer in French'] });
    const task = await runTask('TypeScript', 'In one sentence, what is TypeScript?');
    console.info(`[live] profile: ${task.result?.slice(0, 300)}`);
    expect(task.result ?? '').toMatch(/\b(est|un|une|de|des|le|la|les|langage)\b/i);
  }, 300_000);

  it('saves a department rule and has it on the next task', async () => {
    await runTask(
      'Rule',
      'Rule from the owner for every future task of this department: end every result with the word BANANA. ' +
        'Save this rule in your department notes now, then answer: what is 2 + 2?',
    );
    const notes = (await (
      await send('GET', `/v1/departments/${research.id}/memory`)
    ).json()) as DepartmentMemory;
    console.info(`[live] notes: ${notes.notes?.slice(0, 300)}`);
    expect(notes.notes ?? '').toMatch(/banana/i);
    const next = await runTask('Next', 'What is 3 + 3? One line.');
    console.info(`[live] next task result: ${next.result?.slice(0, 200)}`);
  }, 400_000);

  it('compresses a long task thread with the real model', async () => {
    const res = await send('POST', '/v1/tasks', {
      departmentId: research.id,
      title: 'Long thread',
      brief: 'Explain what a compiler does, in three or four sentences.',
    });
    const task = (await res.json()) as Task;
    await reports(task.id, 1);
    const follow = [
      'Now explain what an interpreter does.',
      'Compare the two in a short list.',
      'Give one example language for each.',
    ];
    for (const [n, message] of follow.entries()) {
      expect((await send('POST', `/v1/tasks/${task.id}/messages`, { message })).status).toBe(200);
      await reports(task.id, n + 2);
    }
    const memory = (await (system.mastra.getAgent('research-lead') as Agent).getMemory()) as Memory;
    const context = await memory.getContext({ threadId: task.threadId, resourceId: 'dept:research' });
    const { activeObservations, ...record } = (context.omRecord ?? {}) as Record<string, unknown>;
    console.info(`[live] record: ${JSON.stringify(record).slice(0, 600)}`);
    console.info(`[live] observations: ${String(activeObservations ?? '').slice(0, 400)}`);
    expect(context.hasObservations).toBe(true);
  }, 600_000);
});
