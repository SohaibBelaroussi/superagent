// Live M9 check: a real model's task is counted, its tokens from the provider's own usage, and priced.
// Needs LIVE_LLM_* in .env. Run with `pnpm test:live`.
import type { Department, Provider, Task, TaskEvent, UsageReport } from '@superagent/shared';
import { sql } from 'drizzle-orm';
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
/** Made-up prices, USD per million tokens: the check is that calls are priced, not what they cost. */
const PRICE = { inputUsd: 1, outputUsd: 4 };

describe.skipIf(!configured)('live usage and cost', () => {
  let system: System;
  let provider: Provider;
  let team: Department;
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    system = await startTestSystem();
    provider = (await (
      await send('POST', '/v1/providers', {
        slug: 'live',
        name: 'Live',
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
      })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    // Not every server lists its models: the one we use is added by hand if needed.
    await send('POST', `/v1/providers/${provider.id}/models`, { modelId: live.model });
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'live', model: live.model } } });
    const priced = await send('PUT', `/v1/providers/${provider.id}/prices`, {
      modelId: live.model,
      ...PRICE,
    });
    expect(priced.status, await priced.clone().text()).toBe(200);
    team = (await (
      await send('POST', '/v1/departments', {
        slug: 'writing',
        name: 'Writing',
        description: 'Writes short texts.',
      })
    ).json()) as Department;
    for (const agent of [
      {
        key: 'writing-lead',
        name: 'Writing lead',
        role: 'lead',
        description: 'Plans writing work and reports it.',
        instructions: 'Hand the writing to your writer, then report the text to the chief.',
      },
      {
        key: 'writer',
        name: 'Writer',
        role: 'specialist',
        description: 'Writes short texts.',
        instructions: 'Write exactly what is asked, briefly.',
      },
    ]) {
      const res = await send('POST', '/v1/agents', { ...agent, departmentId: team.id });
      expect(res.status, await res.clone().text()).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    await system?.close();
  });

  it("counts a task's calls from the provider's usage, and prices them", async () => {
    const res = await send('POST', '/v1/tasks', {
      departmentId: team.id,
      title: 'A haiku about backups',
      brief: 'Ask the writer for one haiku about backups, then report it.',
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    const deadline = Date.now() + 240_000;
    for (;;) {
      const events = (
        (await (await send('GET', `/v1/tasks/${task.id}/events`)).json()) as { items: TaskEvent[] }
      ).items;
      if (events.some((e) => e.type === 'reported')) break;
      if (Date.now() > deadline) throw new Error('No report in time');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // The lead's last request ends after its report.
    let current = task;
    let last = -1;
    for (let i = 0; i < 30; i++) {
      await system.mastra.observability.flush();
      await system.usage.flush();
      current = (await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task;
      if (current.usage.calls > 0 && current.usage.calls === last) break;
      last = current.usage.calls;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const { usage } = current;
    console.info(
      `[live] #${current.number}: ${usage.calls} calls, ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out, $${usage.costUsd}`,
    );
    expect(usage.calls).toBeGreaterThanOrEqual(2);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.unpricedCalls).toBe(0);
    expect(usage.costUsd).toBeGreaterThan(0);
    const byAgent = (await (await send('GET', '/v1/usage?group=agent')).json()) as UsageReport;
    console.info(`[live] by agent: ${byAgent.items.map((i) => `${i.key} ${i.calls}`).join(', ')}`);
    expect(byAgent.items.map((item) => item.key)).toEqual(expect.arrayContaining(['writing-lead', 'writer']));
    // The trace is tagged with the task and its department.
    const tagged = await system.db.execute(
      sql`select count(*)::int as n from mastra.mastra_ai_spans where tags @> ${JSON.stringify([`task:${task.id}`, 'dept:writing'])}::jsonb`,
    );
    expect((tagged.rows[0] as { n: number }).n).toBeGreaterThan(0);
  }, 300_000);
});
