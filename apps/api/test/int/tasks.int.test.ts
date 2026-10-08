import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  Artifact,
  Board,
  CreatedToken,
  Department,
  Provider,
  Task,
  TaskEvent,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { taskEvents } from '../../src/db/schema';
import { type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { type FakeWeb, startFakeWeb } from '../support/fake-web';
import { authHeader, jsonHeaders, startTestSystem, TEST_ADMIN_TOKEN } from './helpers';

const WEB_TOKEN = 'crawl-token-for-tests-0123456789';

type ChatMessage = { role: string; content: unknown };
type TaskPage = { items: Task[]; nextCursor: string | null };
type SseFrame = { event?: string; id?: string; data?: string };

const messagesOf = (r: RecordedRequest) => (r.body?.messages as ChatMessage[] | undefined) ?? [];
const systemPrompt = (r: RecordedRequest) =>
  messagesOf(r)
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const conversation = (r: RecordedRequest) => JSON.stringify(messagesOf(r).filter((m) => m.role !== 'system'));
const toolNames = (r: RecordedRequest | undefined) =>
  ((r?.body?.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name);

/** Checks that `expected` appears in `actual` in this order (other entries may sit in between). */
function expectInOrder(actual: string[], expected: string[]) {
  let from = 0;
  for (const item of expected) {
    const index = actual.indexOf(item, from);
    expect(index, `${item} after position ${from} in ${actual.join(', ')}`).toBeGreaterThanOrEqual(0);
    from = index + 1;
  }
}

describe('tasks, board and dispatch', () => {
  let system: System;
  let fake: FakeOpenAI;
  let web: FakeWeb;
  let research: Department;
  let lead: AgentDefinition;
  let first: Task;

  const send = (method: string, path: string, body?: unknown) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const createTask = async (body: Record<string, unknown>) => {
    const res = await send('POST', '/v1/tasks', { departmentId: research.id, ...body });
    expect(res.status).toBe(201);
    return (await res.json()) as Task;
  };
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;
  const eventsOf = async (id: string) =>
    ((await (await send('GET', `/v1/tasks/${id}/events`)).json()) as { items: TaskEvent[] }).items;
  const chatRequests = (from = 0) => fake.requests.slice(from).filter((r) => r.path === '/chat/completions');

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs = 15_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting; last value: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const waitForPhase = (id: string, phase: Task['phase']) =>
    waitFor(
      () => getTask(id),
      (t) => t.phase === phase,
    );
  const waitForEvents = (id: string, type: string, count = 1, timeoutMs = 15_000) =>
    waitFor(
      () => eventsOf(id),
      (list) => list.filter((e) => e.type === type).length >= count,
      timeoutMs,
    );
  /** The lead's model calls for one task (its brief names the task). */
  const leadCallsFor = (title: string) =>
    chatRequests().filter(
      (r) => systemPrompt(r).includes('lead of the Research') && conversation(r).includes(title),
    );

  /** Opens the SSE stream and reads it frame by frame. */
  async function openEvents(query = '', lastEventId?: number) {
    const res = await system.app.request(`/v1/events${query}`, {
      headers: {
        ...authHeader(),
        ...(lastEventId !== undefined ? { 'Last-Event-ID': String(lastEventId) } : {}),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = res.body;
    if (!body) throw new Error('No stream body');
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const next = async (): Promise<SseFrame> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (raw.startsWith(':')) continue;
          const frame: Record<string, string> = {};
          for (const line of raw.split('\n')) {
            const colon = line.indexOf(':');
            frame[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          return frame;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream ended');
        buffer += value;
      }
    };
    let ready: SseFrame | undefined;
    const untilReady = async () => {
      const frames: SseFrame[] = [];
      for (;;) {
        const frame = await next();
        if (frame.event === 'ready') {
          ready = frame;
          return frames;
        }
        frames.push(frame);
      }
    };
    return { next, untilReady, ready: () => ready, close: () => reader.cancel() };
  }

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    web = await startFakeWeb();
    system = await startTestSystem({
      env: { SEARXNG_URL: web.url, CRAWL4AI_URL: web.url, CRAWL4AI_API_TOKEN: WEB_TOKEN },
    });
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });

    research = (await (
      await send('POST', '/v1/departments', {
        slug: 'research',
        name: 'Research',
        description: 'Finds things out.',
      })
    ).json()) as Department;
    lead = (await (
      await send('POST', '/v1/agents', {
        key: 'research-lead',
        name: 'Research lead',
        role: 'lead',
        departmentId: research.id,
        description: 'Plans research.',
        instructions: 'Be brief.',
      })
    ).json()) as AgentDefinition;
    await send('POST', '/v1/agents', {
      key: 'web-researcher',
      name: 'Web researcher',
      role: 'specialist',
      departmentId: research.id,
      description: 'Searches the web.',
      instructions: 'List sources.',
      tools: [{ key: 'web_search' }, { key: 'fetch_page' }],
    });
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
    await web?.close();
  });

  it('creates a task and sends it to the department lead', async () => {
    first = await createTask({
      title: 'Research Mastra',
      brief: 'Find out what Mastra is. [artifact]',
      priority: 'high',
    });
    expect(first).toMatchObject({
      number: 1,
      phase: 'queued',
      priority: 'high',
      source: 'owner',
      leadAgentId: lead.id,
      threadId: `task:${first.id}`,
      closedAt: null,
    });
  });

  it('lets the lead work the task through to review and tells the chief', async () => {
    const reviewed = await waitForPhase(first.id, 'review');
    expect(reviewed).toMatchObject({
      progress: 100,
      checklist: [
        { text: 'Search the web', done: false },
        { text: 'Write the summary', done: false },
      ],
      result: expect.stringContaining('TypeScript framework'),
    });

    const events = await waitForEvents(first.id, 'chief_notified');
    expectInOrder(
      events.map((e) => e.type),
      ['created', 'phase_changed', 'progress', 'artifact_added', 'reported', 'chief_notified'],
    );
    expect(events.map((e) => e.type)).toContain('dispatched');
    expect(events.find((e) => e.type === 'progress')).toMatchObject({
      actor: 'agent:research-lead',
      phase: 'working',
    });
    expect(events.find((e) => e.type === 'reported')).toMatchObject({
      actor: 'agent:research-lead',
      phase: 'review',
      data: { outcome: 'done', summary: 'Mastra is a TypeScript agent framework.' },
    });
    expect(events.find((e) => e.type === 'chief_notified')?.data).toMatchObject({
      kind: 'task-done',
      decision: 'deliver',
    });
    // Sequence numbers increase and every event carries the task's number and department.
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(new Set(events.map((e) => `${e.taskNumber}/${e.departmentId}`))).toEqual(
      new Set([`1/${research.id}`]),
    );

    const artifacts = (
      (await (await send('GET', `/v1/tasks/${first.id}/artifacts`)).json()) as { items: Artifact[] }
    ).items;
    expect(artifacts).toMatchObject([
      { kind: 'text', title: 'Summary', content: expect.stringContaining('Mastra') },
    ]);

    // The lead got the brief on the task's thread, with the ledger tools next to its team.
    const leadCall = chatRequests().find((r) => systemPrompt(r).includes('lead of the Research department'));
    expect(leadCall && conversation(leadCall)).toContain('Task #1: Research Mastra');
    expect(toolNames(leadCall)).toEqual(
      expect.arrayContaining(['update_task', 'add_artifact', 'report_to_chief', 'agent-web-researcher']),
    );
    // The chief heard about it as a notification in its own thread.
    // The event is written when the chief accepts the signal; its model call follows.
    const chiefCall = await waitFor(
      async () =>
        chatRequests().find(
          (r) => systemPrompt(r).includes('chief of staff') && conversation(r).includes('<notification'),
        ),
      Boolean,
    );
    expect(chiefCall && conversation(chiefCall)).toContain(
      '#1 Research Mastra: Mastra is a TypeScript agent framework.',
    );
  });

  it('accepts a task in review', async () => {
    const res = await send('PATCH', `/v1/tasks/${first.id}`, { phase: 'done' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: 'done', closedAt: expect.any(String) });

    const again = await send('PATCH', `/v1/tasks/${first.id}`, { phase: 'done' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'invalid_transition' });
  });

  it('reopens a closed task and sends it back to the lead', async () => {
    const res = await send('PATCH', `/v1/tasks/${first.id}`, { phase: 'queued' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: 'queued', closedAt: null });
    await waitForEvents(first.id, 'reported', 2);
    expect((await getTask(first.id)).phase).toBe('review');
  });

  it('passes owner messages to the lead, who still has the task history', async () => {
    await waitForEvents(first.id, 'chief_notified', 2);
    const mark = fake.requests.length;
    const res = await send('POST', `/v1/tasks/${first.id}/messages`, {
      message: 'Please add a second source.',
      mode: 'steer',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).phase).toBe('queued');
    const events = await waitForEvents(first.id, 'reported', 3);
    expect(events.find((e) => e.type === 'message')).toMatchObject({
      actor: 'owner',
      data: { mode: 'steer', text: 'Please add a second source.' },
    });

    const leadCall = chatRequests(mark).find(
      (r) =>
        systemPrompt(r).includes('lead of the Research') &&
        conversation(r).includes('Please add a second source.'),
    );
    expect(leadCall && conversation(leadCall)).toContain('Task #1: Research Mastra');
  });

  it('flags a lead that stops without reporting, and resumes when the owner answers', async () => {
    const task = await createTask({
      title: 'Compare frameworks',
      brief: 'Compare Mastra with others. [no-report]',
    });
    await waitForPhase(task.id, 'waiting');
    const events = await waitForEvents(task.id, 'chief_notified');
    expect(events.find((e) => e.type === 'phase_changed' && e.data.to === 'waiting')).toMatchObject({
      actor: 'system',
      data: { reason: 'The lead finished its turn without reporting a result' },
    });
    expect(events.find((e) => e.type === 'chief_notified')?.data).toMatchObject({
      kind: 'task-stalled',
      priority: 'high',
    });

    const answer = await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Report what you have.' });
    expect(answer.status).toBe(200);
    await waitForEvents(task.id, 'reported');
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('delivers a message that arrives while the lead is finishing its turn', async () => {
    // [linger] holds the lead's final answer, so the message lands in the run that is wrapping up.
    const task = await createTask({ title: 'Lingering', brief: 'Find out what Mastra is. [linger]' });
    await waitForEvents(task.id, 'chief_notified');
    const res = await send('POST', `/v1/tasks/${task.id}/messages`, {
      message: 'One more thing: add sources.',
    });
    expect(res.status).toBe(200);
    await waitForEvents(task.id, 'reported', 2);
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('steers a lead in the middle of its turn', async () => {
    // [slow] keeps the lead's turn going long enough to message it mid-run.
    const task = await createTask({ title: 'Steered', brief: 'Find out what Mastra is. [slow]' });
    await waitFor(
      () => getTask(task.id),
      (t) => t.phase === 'working',
    );
    const res = await send('POST', `/v1/tasks/${task.id}/messages`, {
      message: 'Focus on the docs site.',
      mode: 'steer',
    });
    expect(res.status).toBe(200);
    const events = await waitForEvents(task.id, 'reported');
    expect(events.find((e) => e.type === 'message')?.data).toMatchObject({ action: 'deliver' });
    // The message reached the running turn: a later model call in the same run carries it.
    const steered = chatRequests().filter(
      (r) => conversation(r).includes('Task #') && conversation(r).includes('Focus on the docs site.'),
    );
    expect(steered.length).toBeGreaterThan(0);
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('cancels a task and stops the lead mid-run', async () => {
    const task = await createTask({ title: 'Slow job', brief: 'Take your time. [slow]' });
    const res = await send('POST', `/v1/tasks/${task.id}/cancel`, { reason: 'Changed my mind' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: 'cancelled', closedAt: expect.any(String) });

    // Each model answer takes 0.8 s here: an unstopped lead would have asked again by now.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(chatRequests().filter((r) => conversation(r).includes('Slow job')).length).toBeLessThanOrEqual(1);
    const events = await eventsOf(task.id);
    expect(events.map((e) => e.type)).not.toContain('progress');
    expect(events.find((e) => e.type === 'phase_changed' && e.data.to === 'cancelled')?.data).toMatchObject({
      reason: 'Changed my mind',
    });

    const again = await send('POST', `/v1/tasks/${task.id}/cancel`, {});
    expect(again.status).toBe(409);
  });

  it('refuses to re-send a task in progress at once, and still catches its stall', async () => {
    const task = await createTask({ title: 'Busy lead', brief: 'Keep going. [slow] [no-report]' });
    await waitForPhase(task.id, 'working');
    const started = Date.now();
    const res = await send('PATCH', `/v1/tasks/${task.id}`, { phase: 'queued' });
    expect(res.status).toBe(409);
    expect(Date.now() - started).toBeLessThan(1000);
    const events = await waitForEvents(task.id, 'chief_notified');
    expect(events.find((e) => e.type === 'chief_notified')?.data).toMatchObject({ kind: 'task-stalled' });
    expect((await getTask(task.id)).phase).toBe('waiting');
  });

  it('keeps watching the lead after a double dispatch', async () => {
    const task = await createTask({ title: 'Double click', brief: 'Look into it. [no-report]' });
    await waitForEvents(task.id, 'chief_notified');
    const [a, b] = await Promise.all([
      send('PATCH', `/v1/tasks/${task.id}`, { phase: 'queued' }),
      send('PATCH', `/v1/tasks/${task.id}`, { phase: 'queued' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // The run the winning dispatch started stalls too, and is caught.
    const events = await waitForEvents(task.id, 'chief_notified', 2);
    expect(events.filter((e) => e.type === 'chief_notified').map((e) => e.data.kind)).toEqual([
      'task-stalled',
      'task-stalled',
    ]);
  });

  it('runs a queued message as the lead’s next turn', async () => {
    const task = await createTask({ title: 'Queue it', brief: 'Find out what Mastra is. [slow]' });
    await waitForPhase(task.id, 'working');
    const res = await send('POST', `/v1/tasks/${task.id}/messages`, {
      message: 'Afterwards, list two alternatives.',
      mode: 'queue',
    });
    expect(res.status).toBe(200);
    const events = await waitForEvents(task.id, 'reported', 2, 30_000);
    expect(events.find((e) => e.type === 'message')?.data).toMatchObject({ mode: 'queue', action: 'queued' });
    const turn = leadCallsFor('Queue it').find((r) => {
      const users = messagesOf(r).filter((m) => m.role === 'user');
      return JSON.stringify(users.at(-1)?.content).includes('Afterwards, list two alternatives.');
    });
    expect(turn, 'the queued message started a turn of its own').toBeDefined();
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('lets the lead act on a message that reaches it just after it reported', async () => {
    // [slow-report] holds the model call that reports; the owner writes during it.
    const task = await createTask({ title: 'Last word', brief: 'Find out what Mastra is. [slow-report]' });
    await waitFor(
      async () => leadCallsFor('Last word').length,
      (calls) => calls >= 3,
    );
    const res = await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Also name the license.' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).phase).toBe('working');
    const events = await waitForEvents(task.id, 'reported', 2, 30_000);
    expect(events.find((e) => e.type === 'message')?.data).toMatchObject({ action: 'deliver' });
    expect(events.find((e) => e.type === 'phase_changed' && e.data.from === 'review')?.data).toMatchObject({
      to: 'working',
      reason: 'A message reached the lead after its report',
    });
    expect((await getTask(task.id)).phase).toBe('review');
  });

  it('hands open tasks to the department’s new lead', async () => {
    const support = (await (
      await send('POST', '/v1/departments', { slug: 'support', name: 'Support', description: 'Helps.' })
    ).json()) as Department;
    const firstLead = (await (
      await send('POST', '/v1/agents', {
        key: 'support-lead',
        name: 'Support lead',
        role: 'lead',
        departmentId: support.id,
        description: 'Answers questions.',
        instructions: 'Be kind.',
      })
    ).json()) as AgentDefinition;
    const open = async (title: string) => {
      const res = await send('POST', '/v1/tasks', {
        departmentId: support.id,
        title,
        brief: 'Help. [no-report]',
      });
      const task = (await res.json()) as Task;
      await waitForEvents(task.id, 'chief_notified');
      return task;
    };
    const toMessage = await open('Reply to a customer');
    const toCancel = await open('Old request');
    expect((await send('DELETE', `/v1/agents/${firstLead.id}`)).status).toBe(204);
    const nextLead = (await (
      await send('POST', '/v1/agents', {
        key: 'support-lead-2',
        name: 'New support lead',
        role: 'lead',
        departmentId: support.id,
        description: 'Answers questions.',
        instructions: 'Be kind.',
      })
    ).json()) as AgentDefinition;

    const messaged = await send('POST', `/v1/tasks/${toMessage.id}/messages`, {
      message: 'Please finish this.',
    });
    expect(messaged.status).toBe(200);
    expect(await messaged.json()).toMatchObject({ leadAgentId: nextLead.id });
    const events = await waitForEvents(toMessage.id, 'reported');
    expect(events.find((e) => e.type === 'reassigned')?.data).toMatchObject({ lead: 'support-lead-2' });
    expect(events.find((e) => e.type === 'reported')?.actor).toBe('agent:support-lead-2');

    const cancelled = await send('POST', `/v1/tasks/${toCancel.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as Task).phase).toBe('cancelled');
  });

  it('keys chief assignments by run, so reused tool-call ids create separate tasks', async () => {
    const assign = (thread: string) =>
      send('POST', '/api/agents/chief/generate', {
        messages: [{ role: 'user', content: '[assign] [fixed-ids] Please look into Mastra.' }],
        memory: { thread, resource: 'owner' },
      });
    const before = ((await (await send('GET', '/v1/tasks?limit=200')).json()) as TaskPage).items.length;
    expect((await assign('chief:ids-1')).status).toBe(200);
    expect((await assign('chief:ids-2')).status).toBe(200);
    const after = ((await (await send('GET', '/v1/tasks?limit=200')).json()) as TaskPage).items;
    expect(after.length - before).toBe(2);
    for (const task of after.slice(0, 2)) await waitForEvents(task.id, 'reported');
  });

  it('keeps PATCH all-or-nothing, accepts an empty cancel body, and shows recent events', async () => {
    const task = await createTask({ title: 'Contract', brief: 'Fine print.', dispatch: false });
    const refused = await send('PATCH', `/v1/tasks/${task.id}`, { title: 'Changed', phase: 'done' });
    expect(refused.status).toBe(409);
    expect((await getTask(task.id)).title).toBe('Contract');

    for (const n of [1, 2, 3, 4, 5]) await send('PATCH', `/v1/tasks/${task.id}`, { title: `Contract v${n}` });
    const recent = await system.tasks.recentEvents(task.id, 3);
    expect(recent.map((e) => e.type)).toEqual(['updated', 'updated', 'updated']);
    expect(recent.map((e) => e.seq)).toEqual([...recent.map((e) => e.seq)].sort((a, b) => a - b));
    expect(recent.at(-1)?.seq).toBe((await eventsOf(task.id)).at(-1)?.seq);

    // jsonHeaders() sends Content-Type: application/json; there is no body.
    const cancelled = await send('POST', `/v1/tasks/${task.id}/cancel`);
    expect(cancelled.status).toBe(200);
    const garbled = await system.app.request(`/v1/tasks/${task.id}/cancel`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{not json',
    });
    expect(garbled.status).toBe(400);
  });

  it('streams task events live and replays what a client missed', async () => {
    const unauthenticated = await system.app.request('/v1/events');
    expect(unauthenticated.status).toBe(401);
    // Browsers' EventSource can't set headers, so the token may come as ?apiKey=.
    const viaQuery = await system.app.request(`/v1/events?apiKey=${TEST_ADMIN_TOKEN}`);
    expect(viaQuery.status).toBe(200);
    await viaQuery.body?.cancel();

    const history = await eventsOf(first.id);
    const from = history[2]?.seq ?? 0;
    const stream = await openEvents(`?taskId=${first.id}`, from);
    try {
      const replayed = await stream.untilReady();
      expect(replayed.map((f) => Number(f.id))).toEqual(
        history.filter((e) => e.seq > from).map((e) => e.seq),
      );
      expect(replayed.every((f) => f.event === 'task')).toBe(true);

      // Live: another task's events are filtered out, this task's arrive.
      await createTask({ title: 'Unrelated', brief: 'Not for this stream.', dispatch: false });
      await send('PATCH', `/v1/tasks/${first.id}`, { title: 'Research Mastra (v2)' });
      const live = await stream.next();
      expect(live.event).toBe('task');
      expect(JSON.parse(live.data ?? '{}')).toMatchObject({
        type: 'updated',
        taskId: first.id,
        taskNumber: 1,
        data: { fields: ['title'] },
      });
    } finally {
      await stream.close();
    }

    // A fresh client gets no replay, just the ready marker, whose id is a cursor it can resume from.
    const newest = (await eventsOf(first.id)).at(-1)?.seq ?? 0;
    const fresh = await openEvents();
    try {
      expect(await fresh.untilReady()).toEqual([]);
      const ready = fresh.ready();
      expect(Number(ready?.id)).toBeGreaterThanOrEqual(newest);
      expect(JSON.parse(ready?.data ?? '{}')).toEqual({ lastEventId: Number(ready?.id) });
    } finally {
      await fresh.close();
    }

    const invalid = await system.app.request('/v1/events?taskId=not-a-uuid', { headers: authHeader() });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('ends a stream when the token that opened it is revoked', async () => {
    const created = (await (await send('POST', '/v1/tokens', { name: 'phone' })).json()) as CreatedToken;
    const headers = { authorization: `Bearer ${created.token}` };
    const res = await system.app.request('/v1/events', { headers });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes('event: ready')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Stream ended before ready');
      text += value;
    }

    expect((await send('DELETE', `/v1/tokens/${created.record.id}`)).status).toBe(204);
    // The stream ends right away, not at its next heartbeat (25 s).
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })(),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(ended).toBe(true);
    expect((await system.app.request('/v1/events', { headers })).status).toBe(401);
  });

  it('streams concurrent changes in commit order, and replays from the very start', async () => {
    const batch = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        createTask({ title: `Parallel ${i}`, brief: 'In parallel.', dispatch: false }),
      ),
    );
    const ids = new Set(batch.map((t) => t.id));
    const live = await openEvents(`?departmentId=${research.id}`);
    try {
      await live.untilReady();
      await Promise.all(
        batch.flatMap((t) =>
          [1, 2, 3, 4].map((n) => send('PATCH', `/v1/tasks/${t.id}`, { title: `${t.title} v${n}` })),
        ),
      );
      const seen: number[] = [];
      while (seen.length < 20) {
        const frame = await live.next();
        const event = JSON.parse(frame.data ?? '{}') as TaskEvent;
        if (frame.event === 'task' && ids.has(event.taskId)) seen.push(event.seq);
      }
      // Arrived in seq order, and nothing the log has was skipped.
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      const logged = (await Promise.all(batch.map((t) => eventsOf(t.id))))
        .flat()
        .filter((e) => e.type === 'updated')
        .map((e) => e.seq)
        .sort((a, b) => a - b);
      expect(seen).toEqual(logged);
    } finally {
      await live.close();
    }

    // Seqs start at 1, so cursor 0 replays a task's whole history.
    const target = batch[0]?.id ?? '';
    const fromStart = await openEvents(`?taskId=${target}`, 0);
    try {
      const replayed = await fromStart.untilReady();
      expect(replayed.map((f) => Number(f.id))).toEqual((await eventsOf(target)).map((e) => e.seq));
    } finally {
      await fromStart.close();
    }
  });

  it('asks a client that missed too much to reload instead of replaying it all', async () => {
    const task = await createTask({ title: 'Chatty', brief: 'Lots of events.', dispatch: false });
    await system.db.insert(taskEvents).values(
      Array.from({ length: 5100 }, (_, i) => ({
        taskId: task.id,
        type: 'note',
        actor: 'test',
        phase: 'inbox',
        data: { i },
      })),
    );
    const stream = await openEvents(`?taskId=${task.id}`, 0);
    try {
      const frames = await stream.untilReady();
      expect(frames.filter((f) => f.event === 'task')).toHaveLength(5000);
      expect(frames.at(-1)?.event).toBe('reset');
    } finally {
      await stream.close();
    }
  });

  it('flags tasks interrupted by a restart', async () => {
    const task = await createTask({ title: 'Interrupted', brief: 'Long job.', dispatch: false });
    expect(task.phase).toBe('inbox');
    await system.tasks.transition(task.id, 'queued', 'system', 'system');
    await system.tasks.transition(task.id, 'working', 'system', 'system');

    expect(await system.dispatch.recoverInterrupted()).toBe(1);
    expect((await getTask(task.id)).phase).toBe('waiting');
    const events = await waitForEvents(task.id, 'chief_notified');
    expect(events.find((e) => e.type === 'phase_changed' && e.data.to === 'waiting')?.data.reason).toMatch(
      /restarted/,
    );
    expect(events.find((e) => e.type === 'chief_notified')?.data).toMatchObject({ kind: 'task-interrupted' });
  });

  it('only dispatches to departments with a lead', async () => {
    const ops = (await (
      await send('POST', '/v1/departments', { slug: 'ops', name: 'Operations' })
    ).json()) as Department;
    const refused = await send('POST', '/v1/tasks', {
      departmentId: ops.id,
      title: 'Rotate keys',
      brief: 'Soon.',
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'department_has_no_lead' });
    const listed = (await (await send('GET', `/v1/tasks?departmentId=${ops.id}`)).json()) as TaskPage;
    expect(listed.items).toEqual([]);

    const parked = await send('POST', '/v1/tasks', {
      departmentId: ops.id,
      title: 'Rotate keys',
      brief: 'Soon.',
      dispatch: false,
    });
    expect(parked.status).toBe(201);
    const task = (await parked.json()) as Task;
    expect(task.phase).toBe('inbox');

    const send2 = await send('PATCH', `/v1/tasks/${task.id}`, { phase: 'queued' });
    expect(send2.status).toBe(409);
    expect(await send2.json()).toMatchObject({ code: 'department_has_no_lead' });
    const close = await send('PATCH', `/v1/tasks/${task.id}`, { phase: 'done' });
    expect(close.status).toBe(409);
    expect(await close.json()).toMatchObject({ code: 'invalid_transition' });

    const unknown = await send('POST', '/v1/tasks', { departmentId: randomUUID(), title: 'x', brief: 'y' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'department_not_found' });
    expect((await send('GET', `/v1/tasks/${randomUUID()}`)).status).toBe(404);
  });

  it('lets the chief assign work to a department', async () => {
    const mark = fake.requests.length;
    const res = await send('POST', '/api/agents/chief/generate', {
      messages: [{ role: 'user', content: '[assign] Please look into Mastra for me.' }],
      memory: { thread: 'chief:main', resource: 'owner' },
    });
    expect(res.status).toBe(200);

    const newest = (
      (await (await send('GET', `/v1/tasks?departmentId=${research.id}&limit=1`)).json()) as TaskPage
    ).items[0];
    expect(newest).toMatchObject({ source: 'chief', title: 'Research Mastra', leadAgentId: lead.id });
    await waitForEvents(newest?.id ?? '', 'reported');

    const chiefCall = chatRequests(mark).find((r) => systemPrompt(r).includes('chief of staff'));
    expect(toolNames(chiefCall)).toEqual(
      expect.arrayContaining([
        'create_task',
        'board_overview',
        'inspect_task',
        'message_task',
        'cancel_task',
      ]),
    );
    expect(chiefCall && systemPrompt(chiefCall)).toContain('Research (research)');
  });

  it('returns the first task for a repeated idempotency key', async () => {
    const input = {
      departmentId: research.id,
      title: 'Once',
      brief: 'Only once.',
      priority: 'normal' as const,
      source: 'chief' as const,
      idempotencyKey: 'chief:call-123',
    };
    const one = await system.tasks.create(input, 'chief');
    const two = await system.tasks.create(input, 'chief');
    expect(two.id).toBe(one.id);
  });

  it('pages and filters tasks, and groups them on the board', async () => {
    const page1 = (await (await send('GET', '/v1/tasks?limit=2')).json()) as TaskPage;
    expect(page1.items).toHaveLength(2);
    const [a, b] = page1.items;
    expect((a?.number ?? 0) > (b?.number ?? 0)).toBe(true);
    expect(page1.nextCursor).toBe(String(b?.number));
    const page2 = (await (
      await send('GET', `/v1/tasks?limit=2&cursor=${page1.nextCursor}`)
    ).json()) as TaskPage;
    expect(page2.items[0]?.number).toBe((b?.number ?? 0) - 1);

    const cancelled = (await (await send('GET', '/v1/tasks?phase=cancelled')).json()) as TaskPage;
    expect(cancelled.items.map((t) => t.title)).toEqual(
      expect.arrayContaining(['Slow job', 'Old request', 'Contract v5']),
    );
    expect(cancelled.items.every((t) => t.phase === 'cancelled')).toBe(true);

    const board = (await (await send('GET', `/v1/board?departmentId=${research.id}`)).json()) as Board;
    expect(board.columns.map((c) => c.phase)).toEqual([
      'inbox',
      'queued',
      'working',
      'waiting',
      'review',
      'done',
      'failed',
      'cancelled',
    ]);
    const column = (phase: string) =>
      board.columns.find((c) => c.phase === phase)?.tasks.map((t) => t.title) ?? [];
    expect(column('cancelled').sort()).toEqual(['Contract v5', 'Slow job']);
    expect(column('review')).toEqual(expect.arrayContaining(['Research Mastra (v2)', 'Compare frameworks']));
    expect(column('waiting').sort()).toEqual(['Busy lead', 'Double click', 'Interrupted']);
    expect(board.columns.flatMap((c) => c.tasks).every((t) => t.departmentId === research.id)).toBe(true);
  });
});
