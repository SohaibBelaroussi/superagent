import type {
  AgentDefinition,
  Department,
  DepartmentMemory,
  OwnerProfile,
  Provider,
  Task,
  TaskEvent,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerProfile } from '../../src/db/schema';
import { OBSERVATIONS, REMEMBERED, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { jsonHeaders, startTestSystem } from './helpers';

type ChatMessage = { role: string; content: unknown };
const messagesOf = (r: RecordedRequest) => (r.body?.messages as ChatMessage[] | undefined) ?? [];
const systemPrompt = (r: RecordedRequest) =>
  messagesOf(r)
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

/** The lead's model calls for one task (its brief names the task). */
const leadCallsFor = (calls: RecordedRequest[], title: string) =>
  calls.filter(
    (r) =>
      systemPrompt(r).includes('lead of the Research department') &&
      JSON.stringify(messagesOf(r)).includes(title),
  );

/** A system with a fake provider, a research department, its lead and (optionally) a specialist. */
async function setUp(env: Record<string, string> = {}, withSpecialist = true) {
  const fake = await startFakeOpenAI(['fake-chat']);
  const system = await startTestSystem({ env });
  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const provider = (await (
    await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
  ).json()) as Provider;
  await send('POST', `/v1/providers/${provider.id}/refresh-models`);
  await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
  const research = (await (
    await send('POST', '/v1/departments', {
      slug: 'research',
      name: 'Research',
      description: 'Finds things out.',
    })
  ).json()) as Department;
  await send('POST', '/v1/agents', {
    key: 'research-lead',
    name: 'Research lead',
    role: 'lead',
    departmentId: research.id,
    description: 'Plans research.',
    instructions: 'Be brief.',
  });
  if (withSpecialist) {
    await send('POST', '/v1/agents', {
      key: 'web-researcher',
      name: 'Web researcher',
      role: 'specialist',
      departmentId: research.id,
      description: 'Searches the web.',
      instructions: 'List sources.',
    });
  }

  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  /** Waits until the task has `count` reports and the chief has heard about the last one. */
  const waitForReports = async (id: string, count: number) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const events = await eventsOf(id);
      if (
        events.filter((e) => e.type === 'reported').length >= count &&
        events.at(-1)?.type === 'chief_notified'
      ) {
        return events;
      }
      if (Date.now() > deadline) throw new Error(`Timed out: ${events.map((e) => e.type).join(' > ')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const runTask = async (title: string, brief: string) => {
    const res = await send('POST', '/v1/tasks', { departmentId: research.id, title, brief });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    await waitForReports(task.id, 1);
    return task;
  };
  const chatRequests = (from = 0) => fake.requests.slice(from).filter((r) => r.path === '/chat/completions');
  return { fake, system, send, research, runTask, waitForReports, chatRequests };
}

describe('owner profile and department notes', () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;
  beforeAll(async () => {
    ctx = await setUp();
  });
  afterAll(async () => {
    await ctx?.system.close();
    await ctx?.fake.close();
  });

  it('keeps an owner profile that you can edit', async () => {
    const { send } = ctx;
    expect(await (await send('GET', '/v1/profile')).json()).toEqual({});

    const saved = await send('PATCH', '/v1/profile', {
      name: 'Sohaib',
      communicationStyle: 'Direct, no fluff',
      preferences: ['Prefers short answers'],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      name: 'Sohaib',
      communicationStyle: 'Direct, no fluff',
      preferences: ['Prefers short answers'],
    });

    const removed = (await (
      await send('PATCH', '/v1/profile', { communicationStyle: null })
    ).json()) as OwnerProfile;
    expect(removed).toEqual({ name: 'Sohaib', preferences: ['Prefers short answers'] });

    const invalid = await send('PATCH', '/v1/profile', { preferences: 'not a list' });
    expect(invalid.status).toBe(400);
  });

  it('gives every department agent a read-only copy of the profile', async () => {
    const mark = ctx.fake.requests.length;
    await ctx.runTask('Profile check', 'Find out what Mastra is.');
    const calls = ctx.chatRequests(mark);
    const lead = leadCallsFor(calls, 'Profile check')[0];
    const specialist = calls.find((r) => systemPrompt(r).includes('specialist in the Research department'));
    for (const call of [lead, specialist]) {
      expect(call && systemPrompt(call)).toContain('<owner_profile>');
      expect(call && systemPrompt(call)).toContain('Prefers short answers');
    }
  });

  it('lets the chief learn about you', async () => {
    const res = await ctx.send('POST', '/api/agents/chief/generate', {
      messages: [{ role: 'user', content: '[remember] By the way, I like answers in French.' }],
      memory: { thread: 'chief:main', resource: 'owner' },
    });
    expect(res.status).toBe(200);
    // Lists are replaced, other fields kept.
    expect(await (await ctx.send('GET', '/v1/profile')).json()).toEqual({
      name: 'Sohaib',
      preferences: [REMEMBERED.preference],
    });
  });

  it("carries a department's notes from one task to the next", async () => {
    const { send, research } = ctx;
    expect(await (await send('GET', `/v1/departments/${research.id}/memory`)).json()).toEqual({
      departmentId: research.id,
      notes: null,
    });

    await ctx.runTask('Task A', 'Research Mastra. The owner wants two sources every time. [remember]');
    const memory = (await (
      await send('GET', `/v1/departments/${research.id}/memory`)
    ).json()) as DepartmentMemory;
    expect(memory.notes).toContain(REMEMBERED.note);

    const mark = ctx.fake.requests.length;
    await ctx.runTask('Task B', 'Research Mastra again.');
    // By title: the previous task's last model call may still land after the mark.
    const lead = leadCallsFor(ctx.chatRequests(mark), 'Task B')[0];
    expect(lead && systemPrompt(lead)).toContain(REMEMBERED.note);

    // Corrections from the owner apply on the next task.
    const replaced = await send('PUT', `/v1/departments/${research.id}/memory`, {
      notes: '# Department notes\n- Use metric units.',
    });
    expect(replaced.status).toBe(200);
    const next = ctx.fake.requests.length;
    await ctx.runTask('Task C', 'Research Mastra once more.');
    const corrected = leadCallsFor(ctx.chatRequests(next), 'Task C')[0];
    expect(corrected && systemPrompt(corrected)).toContain('Use metric units.');
    expect(corrected && systemPrompt(corrected)).not.toContain(REMEMBERED.note);

    expect((await send('GET', '/v1/departments/01900000-0000-7000-8000-000000000000/memory')).status).toBe(
      404,
    );
  });

  it('keeps the valid fields of a stored profile that no longer fits', async () => {
    // As if an older version had stored preferences as text.
    await ctx.system.db
      .insert(ownerProfile)
      .values({ id: 'owner', profile: { name: 'Sohaib', preferences: 'metric', about: 'Builds agents' } })
      .onConflictDoUpdate({
        target: ownerProfile.id,
        set: { profile: { name: 'Sohaib', preferences: 'metric', about: 'Builds agents' } },
      });
    expect(await (await ctx.send('GET', '/v1/profile')).json()).toEqual({
      name: 'Sohaib',
      about: 'Builds agents',
    });
    const patched = await ctx.send('PATCH', '/v1/profile', { timezone: 'Asia/Qatar' });
    expect(await patched.json()).toEqual({ name: 'Sohaib', about: 'Builds agents', timezone: 'Asia/Qatar' });
  });

  it('never loses a write when the owner, the chief and leads save at once', async () => {
    const { send, system, research } = ctx;
    await Promise.all([
      send('PATCH', '/v1/profile', { language: 'English' }),
      send('PATCH', '/v1/profile', { communicationStyle: 'Short' }),
      system.memory.updateProfile({ preferences: ['Metric units'] }),
    ]);
    expect(await (await send('GET', '/v1/profile')).json()).toMatchObject({
      language: 'English',
      communicationStyle: 'Short',
      preferences: ['Metric units'],
    });

    const lessons = ['One', 'Two', 'Three', 'Four', 'Five'].map((n) => `Lesson ${n}.`);
    await Promise.all(lessons.map((note) => system.memory.addDepartmentNote(research.id, note)));
    const { notes } = (await (
      await send('GET', `/v1/departments/${research.id}/memory`)
    ).json()) as DepartmentMemory;
    for (const note of lessons) expect(notes).toContain(`- ${note}`);
    // Saving the same lesson twice keeps one line.
    await system.memory.addDepartmentNote(research.id, 'Lesson One.');
    const again = (await (
      await send('GET', `/v1/departments/${research.id}/memory`)
    ).json()) as DepartmentMemory;
    expect(again.notes?.split('- Lesson One.').length).toBe(2);
  });

  it('still answers direct calls that have no thread', async () => {
    const res = await ctx.send('POST', '/api/agents/research-lead/generate', {
      messages: [{ role: 'user', content: 'Quick question.' }],
    });
    expect(res.status).toBe(200);
  });
});

describe('long threads', () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;
  let lead: AgentDefinition | undefined;
  beforeAll(async () => {
    // Tiny thresholds so a few turns are enough to compress, observing only at the threshold.
    ctx = await setUp(
      { MEMORY_OBSERVE_TOKENS: '300', MEMORY_REFLECT_TOKENS: '100000', MEMORY_OBSERVE_AHEAD: 'false' },
      false,
    );
    const { items } = (await (await ctx.send('GET', '/v1/agents')).json()) as { items: AgentDefinition[] };
    lead = items.find((a) => a.key === 'research-lead');
  });
  afterAll(async () => {
    await ctx?.system.close();
    await ctx?.fake.close();
  });

  it('compresses a long task thread into observations without errors', async () => {
    expect(lead).toBeDefined();
    const task = await ctx.runTask('Long thread', 'Find out what Mastra is and keep me posted.');
    for (const [n, text] of [
      'Add the license.',
      'Add the main features.',
      'Add who maintains it.',
    ].entries()) {
      const res = await ctx.send('POST', `/v1/tasks/${task.id}/messages`, { message: text });
      expect(res.status).toBe(200);
      await ctx.waitForReports(task.id, n + 2);
    }
    const calls = ctx.chatRequests();
    const observerCalls = calls.filter((r) => systemPrompt(r).includes('memory consciousness'));
    expect(observerCalls.length).toBeGreaterThan(0);
    // After compression the lead works from the observations, not the whole thread.
    const compressed = calls.filter(
      (r) =>
        systemPrompt(r).includes('lead of the Research department') &&
        systemPrompt(r).includes('<observations>'),
    );
    expect(compressed.length).toBeGreaterThan(0);
    expect(systemPrompt(compressed.at(-1) as RecordedRequest)).toContain(
      OBSERVATIONS.split('\n')[2]?.replace('* ', '').trim() ?? '',
    );
    // Every turn reported: nothing was cut short by the compression.
    const task2 = (await (await ctx.send('GET', `/v1/tasks/${task.id}`)).json()) as Task;
    expect(task2.phase).toBe('review');

    // Mastra's memory routes still see observational memory.
    const config = await ctx.send('GET', '/api/memory/config?agentId=research-lead');
    expect(config.status).toBe(200);
    expect(JSON.stringify(await config.json())).toMatch(/"observationalMemory":\{"enabled":true/);
  });

  it('compresses with the default model while the fast one cannot be used', async () => {
    const fast = await startFakeOpenAI(['fake-fast']);
    try {
      const provider = (await (
        await ctx.send('POST', '/v1/providers', { slug: 'quick', name: 'Quick', baseUrl: fast.url })
      ).json()) as Provider;
      await ctx.send('POST', `/v1/providers/${provider.id}/refresh-models`);
      await ctx.send('PATCH', '/v1/settings', {
        models: { fast: { provider: 'quick', model: 'fake-fast' } },
      });
      const observed = (fake: { requests: RecordedRequest[] }) =>
        fake.requests.filter(
          (r) => r.path === '/chat/completions' && systemPrompt(r).includes('memory consciousness'),
        ).length;

      const task = await ctx.runTask('Fast observer', 'Find out what Mastra is and keep me posted.');
      await ctx.send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Add the license.' });
      await ctx.waitForReports(task.id, 2);
      expect(observed(fast)).toBeGreaterThan(0);

      // The fast model's provider goes away: compression falls back instead of failing every turn.
      const disabled = await ctx.send('PATCH', `/v1/providers/${provider.id}`, { enabled: false });
      expect(disabled.status).toBe(200);
      const before = observed(ctx.fake);
      for (const [n, text] of ['Add the features.', 'Add who maintains it.'].entries()) {
        await ctx.send('POST', `/v1/tasks/${task.id}/messages`, { message: text });
        await ctx.waitForReports(task.id, n + 3);
      }
      expect(observed(ctx.fake)).toBeGreaterThan(before);
      expect(((await (await ctx.send('GET', `/v1/tasks/${task.id}`)).json()) as Task).phase).toBe('review');
    } finally {
      await fast.close();
    }
  });
});
