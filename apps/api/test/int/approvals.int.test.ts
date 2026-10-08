import type {
  AttentionItem,
  AttentionList,
  Decision,
  Department,
  Provider,
  Task,
  TaskEvent,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { decisions } from '../../src/db/schema';
import { type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { type FakeWeb, startFakeWeb } from '../support/fake-web';
import { jsonHeaders, startTestSystem } from './helpers';

const WEB_TOKEN = 'crawl-token-for-tests-0123456789';
type ChatMessage = { role: string; content: unknown };

describe('approvals and attention', () => {
  let system: System;
  let fake: FakeOpenAI;
  let web: FakeWeb;
  let ops: Department;

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    system.app.request(path, {
      method,
      headers: { ...jsonHeaders(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  const attention = async () => ((await (await send('GET', '/v1/attention')).json()) as AttentionList).items;
  const waitFor = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  /** Creates a task for the gated lead and waits until it stops for approval. */
  const gatedTask = async (title: string) => {
    const res = await send('POST', '/v1/tasks', {
      departmentId: ops.id,
      title,
      brief: 'Look up the Mastra framework.',
    });
    const task = (await res.json()) as Task;
    await waitFor(
      () => eventsOf(task.id),
      (events) => events.some((e) => e.type === 'approval_requested'),
      'approval',
    );
    const item = await waitFor(
      async () => (await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id),
      Boolean,
      'attention item',
    );
    return { task, item: item as AttentionItem };
  };
  const decide = (item: AttentionItem, kind: 'approve' | 'decline', body?: unknown, key?: string) =>
    send(
      'POST',
      `/v1/attention/${encodeURIComponent(item.id)}/${kind}`,
      body,
      key ? { 'idempotency-key': key } : {},
    );
  const waitForPhase = (id: string, phase: Task['phase']) =>
    waitFor(
      async () => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task,
      (t) => t.phase === phase,
      phase,
    );

  async function boot(databaseUrl?: string) {
    system = await startTestSystem({
      databaseUrl,
      env: { SEARXNG_URL: web.url, CRAWL4AI_URL: web.url, CRAWL4AI_API_TOKEN: WEB_TOKEN },
    });
  }

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    web = await startFakeWeb();
    await boot();
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    ops = (await (
      await send('POST', '/v1/departments', { slug: 'ops', name: 'Operations' })
    ).json()) as Department;
    const lead = await send('POST', '/v1/agents', {
      key: 'ops-lead',
      name: 'Ops lead',
      role: 'lead',
      departmentId: ops.id,
      description: 'Runs operations.',
      instructions: 'Search before acting.',
      tools: [{ key: 'web_search', requireApproval: true }],
    });
    expect(lead.status).toBe(201);
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
    await web?.close();
  });

  it('stops a gated tool call until the owner approves it, once', async () => {
    const searches = web.searches.length;
    const { task, item } = await gatedTask('Gated search');
    expect(item).toMatchObject({
      kind: 'approval',
      agent: 'ops-lead',
      tool: 'web_search',
      taskNumber: task.number,
      args: { query: 'mastra agent framework' },
    });
    expect(web.searches.length).toBe(searches);
    const events = await waitFor(
      () => eventsOf(task.id),
      (list) => list.some((e) => e.type === 'chief_notified'),
      'chief notified',
    );
    expect(events.find((e) => e.type === 'chief_notified')?.data).toMatchObject({ kind: 'approval-needed' });
    expect(((await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task).phase).toBe('waiting');

    // Nothing else goes to the lead while the decision is pending.
    const message = await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Hurry up.' });
    expect(message.status).toBe(409);
    expect(await message.json()).toMatchObject({ code: 'approval_pending' });
    // Refused before anything is written: the title stays.
    const patched = await send('PATCH', `/v1/tasks/${task.id}`, { title: 'Renamed', phase: 'queued' });
    expect(patched.status).toBe(409);
    expect(((await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task).title).toBe('Gated search');
    const emptyKey = await send('POST', `/v1/attention/${encodeURIComponent(item.id)}/approve`, undefined, {
      'idempotency-key': '',
    });
    expect(emptyKey.status).toBe(400);

    const approved = await decide(item, 'approve', undefined, 'decision-1');
    expect(approved.status).toBe(200);
    const decision = (await approved.json()) as Decision;
    expect(decision).toMatchObject({ kind: 'approve', status: 'applied', taskId: task.id });
    // A retry with the same key returns the first outcome.
    const again = await decide(item, 'approve', undefined, 'decision-1');
    expect(((await again.json()) as Decision).id).toBe(decision.id);

    await waitForPhase(task.id, 'review');
    expect(web.searches.length).toBe(searches + 1);
    expect((await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id)).toBeUndefined();
    const decided = await eventsOf(task.id);
    expect(decided.find((e) => e.type === 'approval_decided')?.data).toMatchObject({ decision: 'approve' });

    const again2 = await decide(item, 'approve', undefined, 'decision-2');
    expect(again2.status).toBe(409);
    expect(await again2.json()).toMatchObject({ code: 'already_decided' });
  });

  it('offers a call only once its task is parked, and never again once decided', async () => {
    const searches = web.searches.length;
    // Every answer takes a while, so the approved run is still going when we look again.
    const res = await send('POST', '/v1/tasks', {
      departmentId: ops.id,
      title: 'Slow gated search',
      brief: 'Look up the Mastra framework. [slow]',
    });
    const task = (await res.json()) as Task;
    let item: AttentionItem | undefined;
    const deadline = Date.now() + 15_000;
    while (!item) {
      if (Date.now() > deadline) throw new Error('Timed out: attention item');
      item = (await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id);
      if (!item) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Listed only after the task was parked, so a decision can't overtake the park.
    expect((await eventsOf(task.id)).map((e) => e.type)).toContain('approval_requested');

    expect((await decide(item, 'approve', undefined, 'slow-1')).status).toBe(200);
    // Mastra still lists the run as suspended while the approved call carries on: we don't.
    expect((await attention()).some((i) => i.kind === 'approval' && i.taskId === task.id)).toBe(false);
    const twice = await decide(item, 'approve', undefined, 'slow-2');
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ code: 'already_decided' });
    const message = await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Thanks.' });
    expect(message.status).not.toBe(409);

    await waitForPhase(task.id, 'review');
    expect(web.searches.length).toBe(searches + 1);
  });

  it('tells the agent why a call was declined', async () => {
    const searches = web.searches.length;
    const mark = fake.requests.length;
    const { task, item } = await gatedTask('Declined search');
    const res = await decide(item, 'decline', { reason: 'Not during the freeze' });
    expect(res.status).toBe(200);
    await waitForPhase(task.id, 'review');
    expect(web.searches.length).toBe(searches);
    const told = fake.requests
      .slice(mark)
      .filter((r: RecordedRequest) => r.path === '/chat/completions')
      .some((r) => JSON.stringify(r.body?.messages as ChatMessage[]).includes('Not during the freeze'));
    expect(told).toBe(true);
  });

  it('declines what a cancelled task was waiting for, for good', async () => {
    const searches = web.searches.length;
    const { task, item } = await gatedTask('Cancelled while waiting');
    expect((await send('POST', `/v1/tasks/${task.id}/cancel`)).status).toBe(200);
    // Gone at once, and recorded: it can't be approved afterwards.
    expect((await attention()).some((i) => i.kind === 'approval' && i.taskId === task.id)).toBe(false);
    const late = await decide(item, 'approve');
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'already_decided' });
    expect(web.searches.length).toBe(searches);
  });

  it("stops the lead after declining a cancelled task's call, after a restart too", async () => {
    const searches = web.searches.length;
    const { task, item } = await gatedTask('Cancelled after a restart');
    const databaseUrl = system.config.DATABASE_URL;
    await system.close();
    await boot(databaseUrl);

    const mark = fake.requests.length;
    expect((await send('POST', `/v1/tasks/${task.id}/cancel`)).status).toBe(200);
    expect((await decide(item, 'approve')).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The decline resumes the lead's turn, which is stopped at once: no more model calls for the task.
    // (The lead's, which alone has report_to_chief: the chief may still read its approval notice.)
    const calls = fake.requests
      .slice(mark)
      .filter(
        (r: RecordedRequest) =>
          r.path === '/chat/completions' &&
          ((r.body?.tools as Array<{ function: { name: string } }> | undefined) ?? []).some(
            (t) => t.function.name === 'report_to_chief',
          ) &&
          JSON.stringify(r.body?.messages).includes('Cancelled after a restart'),
      );
    expect(calls).toHaveLength(0);
    expect(web.searches.length).toBe(searches);
    expect(((await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task).phase).toBe('cancelled');
  });

  it('keeps a pending approval across a restart', async () => {
    const { task, item } = await gatedTask('Across a restart');
    const databaseUrl = system.config.DATABASE_URL;
    await system.close();
    await boot(databaseUrl);

    const after = (await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id);
    expect(after?.id).toBe(item.id);
    expect(((await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task).phase).toBe('waiting');
    const res = await decide(after as AttentionItem, 'approve');
    expect(res.status).toBe(200);
    await waitForPhase(task.id, 'review');
  });

  it('never offers a decided call again when a restart cut its run short', async () => {
    const searches = web.searches.length;
    const res = await send('POST', '/v1/tasks', {
      departmentId: ops.id,
      title: 'Cut short',
      brief: 'Look up the Mastra framework. [slow]',
    });
    const task = (await res.json()) as Task;
    await waitFor(
      () => eventsOf(task.id),
      (events) => events.some((e) => e.type === 'approval_requested'),
      'approval',
    );
    const item = (await waitFor(
      async () => (await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id),
      Boolean,
      'attention item',
    )) as AttentionItem;
    expect((await decide(item, 'approve')).status).toBe(200);
    // Stop while the approved run is still going: Mastra keeps its snapshot as suspended.
    const databaseUrl = system.config.DATABASE_URL;
    await system.close();
    await boot(databaseUrl);

    expect((await attention()).some((i) => i.kind === 'approval' && i.taskId === task.id)).toBe(false);
    const again = await decide(item, 'approve');
    expect(again.status).toBe(409);
    // Flagged as interrupted instead, for the owner to pick up.
    const flagged = (await (await send('GET', `/v1/tasks/${task.id}`)).json()) as Task;
    expect(flagged.phase).toBe('waiting');
    expect(web.searches.length).toBeLessThanOrEqual(searches + 1);
  });

  it('never offers a call the decisions log has, whatever Mastra still lists', async () => {
    const { task, item } = await gatedTask('Decided elsewhere');
    // As if the server had died while carrying out this decision: Mastra still lists the call.
    await system.db.insert(decisions).values({
      id: '01900000-0000-7000-8000-00000000d001',
      idempotencyKey: 'crashed-decision',
      kind: 'approve',
      target: item.id,
      status: 'pending',
      taskId: task.id,
    });
    expect((await attention()).some((i) => i.kind === 'approval' && i.taskId === task.id)).toBe(false);
    expect((await decide(item, 'approve')).status).toBe(409);
    expect((await send('POST', `/v1/tasks/${task.id}/cancel`)).status).toBe(200);
  });

  it('keeps a lead with a call waiting until the call is decided', async () => {
    const audit = (await (
      await send('POST', '/v1/departments', { slug: 'audit', name: 'Audit' })
    ).json()) as Department;
    const lead = (await (
      await send('POST', '/v1/agents', {
        key: 'audit-lead',
        name: 'Audit lead',
        role: 'lead',
        departmentId: audit.id,
        description: 'Audits things.',
        instructions: 'Search first.',
        tools: [{ key: 'web_search', requireApproval: true }],
      })
    ).json()) as { id: string };
    const task = (await (
      await send('POST', '/v1/tasks', { departmentId: audit.id, title: 'Audit', brief: 'Look it up. [slow]' })
    ).json()) as Task;
    // Its run is going: it could still stop for a call nobody could decide once the lead is gone.
    const busy = await send('DELETE', `/v1/agents/${lead.id}`);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: 'agent_busy' });
    const item = (await waitFor(
      async () => (await attention()).find((i) => i.kind === 'approval' && i.taskId === task.id),
      Boolean,
      'attention item',
    )) as AttentionItem;
    const refused = await send('DELETE', `/v1/agents/${lead.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'approvals_pending' });

    expect((await decide(item, 'decline', { reason: 'Not now' })).status).toBe(200);
    await waitForPhase(task.id, 'review');
    // Once its turn is over, the lead can go.
    await waitFor(
      async () => (await send('DELETE', `/v1/agents/${lead.id}`)).status,
      (status) => status === 204,
      'archive',
    );
  });

  it('lists stalled tasks, questions and results to review', async () => {
    const research = (await (
      await send('POST', '/v1/departments', { slug: 'research', name: 'Research' })
    ).json()) as Department;
    await send('POST', '/v1/agents', {
      key: 'research-lead',
      name: 'Research lead',
      role: 'lead',
      departmentId: research.id,
      description: 'Plans research.',
      instructions: 'Be brief.',
    });
    const stalled = (await (
      await send('POST', '/v1/tasks', {
        departmentId: research.id,
        title: 'Stalls',
        brief: 'Think. [no-report]',
      })
    ).json()) as Task;
    const reviewed = (await (
      await send('POST', '/v1/tasks', { departmentId: research.id, title: 'Reports', brief: 'Summarize.' })
    ).json()) as Task;
    await waitForPhase(stalled.id, 'waiting');
    await waitForPhase(reviewed.id, 'review');
    const items = await attention();
    expect(items.find((i) => i.taskId === stalled.id)).toMatchObject({
      kind: 'problem',
      detail: 'The lead finished its turn without reporting a result',
    });
    expect(items.find((i) => i.taskId === reviewed.id)).toMatchObject({ kind: 'review' });
  });
});
