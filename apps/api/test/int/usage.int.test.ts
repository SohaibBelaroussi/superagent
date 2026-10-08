import { randomUUID } from 'node:crypto';
import type {
  Board,
  Department,
  Provider,
  ProviderModel,
  Task,
  TaskEvent,
  UsageReport,
} from '@superagent/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeOpenAI, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem } from './helpers';

/** What the fake model reports for every call. */
const PER_CALL = { input: 11, output: 7 };
/** USD per million tokens. */
const PRICE = { inputUsd: 2, outputUsd: 10 };

describe('usage and cost', () => {
  let system: System;
  let fake: FakeOpenAI;
  let provider: Provider;
  let research: Department;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
  const report = async (query: string) => {
    const res = await send('GET', `/v1/usage?${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as UsageReport;
  };

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label} (${JSON.stringify(value)})`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /** Runs a task to its report, then waits until its last calls are counted. */
  async function runTask(brief: string): Promise<Task> {
    const res = await send('POST', '/v1/tasks', {
      departmentId: research.id,
      title: brief.slice(0, 30),
      brief,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const task = (await res.json()) as Task;
    await waitFor(
      async () =>
        ((await (await send('GET', `/v1/tasks/${task.id}/events`)).json()) as { items: TaskEvent[] }).items,
      (events) => events.some((e) => e.type === 'reported'),
      'the report',
    );
    let last = -1;
    return waitFor(
      async () => {
        await system.mastra.observability.flush();
        await system.usage.flush();
        return getTask(task.id);
      },
      (current) => {
        const settled = current.usage.calls > 0 && current.usage.calls === last;
        last = current.usage.calls;
        return settled;
      },
      'its usage',
    );
  }

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    system = await startTestSystem();
    provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    research = (await (
      await send('POST', '/v1/departments', { slug: 'research', name: 'Research', description: 'Finds out.' })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'research-lead',
        name: 'Research lead',
        role: 'lead',
        description: 'Plans.',
        instructions: 'Be brief.',
      },
      {
        key: 'analyst',
        name: 'Analyst',
        role: 'specialist',
        description: 'Analyses.',
        instructions: 'Be brief.',
      },
    ]) {
      const created = await send('POST', '/v1/agents', { ...agent, departmentId: research.id });
      expect(created.status, await created.clone().text()).toBe(201);
    }
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
  });

  it('prices models: set, shown with the model, removed', async () => {
    expect(
      (await send('PUT', `/v1/providers/${provider.id}/prices`, { modelId: 'nope', ...PRICE })).status,
    ).toBe(404);
    const set = await send('PUT', `/v1/providers/${provider.id}/prices`, { modelId: 'fake-chat', ...PRICE });
    expect(set.status, await set.clone().text()).toBe(200);
    const models = ((await set.json()) as { items: ProviderModel[] }).items;
    expect(models.find((m) => m.modelId === 'fake-chat')?.price).toEqual({ ...PRICE, cachedInputUsd: null });
    expect((await send('DELETE', `/v1/providers/${provider.id}/prices?modelId=nope`)).status).toBe(404);
  });

  it("counts every call of a task (the lead's and its specialist's) on its card, priced", async () => {
    const task = await runTask('Look into Mastra.');
    const { usage } = task;
    // At least the lead's delegation and report, and the specialist's answer.
    expect(usage.calls).toBeGreaterThanOrEqual(3);
    expect(usage).toMatchObject({
      inputTokens: usage.calls * PER_CALL.input,
      outputTokens: usage.calls * PER_CALL.output,
      totalTokens: usage.calls * (PER_CALL.input + PER_CALL.output),
      unpricedCalls: 0,
    });
    expect(usage.costUsd).toBeCloseTo(
      (usage.calls * (PER_CALL.input * PRICE.inputUsd + PER_CALL.output * PRICE.outputUsd)) / 1e6,
      10,
    );
    // The same totals on the board's card and in lists.
    const board = (await (await send('GET', '/v1/board')).json()) as Board;
    const card = board.columns.flatMap((column) => column.tasks).find((t) => t.id === task.id);
    expect(card?.usage).toEqual(usage);
    const list = (await (await send('GET', '/v1/tasks')).json()) as { items: Task[] };
    expect(list.items.find((t) => t.id === task.id)?.usage).toEqual(usage);

    // Both agents' calls, from one trace tagged with the task and its department.
    const byAgent = await report('group=agent');
    expect(byAgent.items.map((item) => item.key)).toEqual(
      expect.arrayContaining(['research-lead', 'analyst']),
    );
    const tagged = await system.db.execute(
      sql`select count(*)::int as n from mastra.mastra_ai_spans where tags @> ${JSON.stringify([`task:${task.id}`, 'dept:research'])}::jsonb`,
    );
    expect((tagged.rows[0] as { n: number }).n).toBeGreaterThan(0);
    const generations = await system.db.execute(
      sql`select count(*)::int as n from mastra.mastra_ai_spans where "spanType" = 'model_inference' and metadata->>'taskId' = ${task.id}`,
    );
    expect((generations.rows[0] as { n: number }).n).toBe(usage.calls);
  });

  it('reports usage by department, task, model and day, and over a period', async () => {
    const task = (await (await send('GET', '/v1/tasks')).json()) as { items: Task[] };
    const first = task.items[0] as Task;
    const byDepartment = await report('group=department');
    const dept = byDepartment.items.find((item) => item.key === research.id);
    expect(dept).toMatchObject({ label: 'Research', calls: first.usage.calls, costUsd: first.usage.costUsd });
    expect(byDepartment.total.calls).toBeGreaterThanOrEqual(first.usage.calls);
    const byTask = await report('group=task');
    expect(byTask.items.find((item) => item.key === first.id)?.label).toBe(`#${first.number} ${first.title}`);
    const byModel = await report('group=model');
    expect(byModel.items.map((item) => item.key)).toContain('fake/fake-chat');
    const byDay = await report('group=day');
    expect(byDay.items.at(-1)?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A board bigger than a query's 65,535 parameters is asked for in chunks.
    const many = [...Array.from({ length: 70_000 }, () => randomUUID()), first.id];
    expect([...(await system.usage.forTasks(many)).keys()]).toEqual([first.id]);
    const future = await report(`group=department&from=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    expect(future).toMatchObject({ items: [], total: { calls: 0, costUsd: 0 } });
    expect((await send('GET', '/v1/usage?group=nope')).status).toBe(400);
  });

  it('counts calls to a model without a price, at no cost', async () => {
    expect((await send('DELETE', `/v1/providers/${provider.id}/prices?modelId=fake-chat`)).status).toBe(204);
    const task = await runTask('Look into Hono.');
    expect(task.usage).toMatchObject({ costUsd: 0, unpricedCalls: task.usage.calls });
    expect(task.usage.calls).toBeGreaterThan(0);
  });
});
