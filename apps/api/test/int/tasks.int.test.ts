import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  Artifact,
  Board,
  Department,
  Provider,
  Task,
  TaskEvent,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeOpenAI, type RecordedRequest, startFakeOpenAI } from '../support/fake-openai';
import { type FakeWeb, startFakeWeb } from '../support/fake-web';
import { authHeader, jsonHeaders, startTestSystem } from './helpers';

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
  const waitForEvents = (id: string, type: string, count = 1) =>
    waitFor(
      () => eventsOf(id),
      (list) => list.filter((e) => e.type === type).length >= count,
    );

  /** Opens the SSE stream and reads it frame by frame. */
  async function openEvents(query = '', lastEventId?: number) {
    const res = await system.app.request(`/v1/events${query}`, {
      headers: { ...authHeader(), ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}) },
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
    const untilReady = async () => {
      const frames: SseFrame[] = [];
      for (let frame = await next(); frame.event !== 'ready'; frame = await next()) frames.push(frame);
      return frames;
    };
    return { next, untilReady, close: () => reader.cancel() };
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
    const chiefCall = chatRequests().find(
      (r) => systemPrompt(r).includes('chief of staff') && conversation(r).includes('<notification'),
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

  it('streams task events live and replays what a client missed', async () => {
    const unauthenticated = await system.app.request('/v1/events');
    expect(unauthenticated.status).toBe(401);

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

    // A fresh client without Last-Event-ID gets no replay, just the ready marker.
    const fresh = await openEvents();
    try {
      expect(await fresh.untilReady()).toEqual([]);
    } finally {
      await fresh.close();
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
    expect(cancelled.items.map((t) => t.title)).toEqual(['Slow job']);

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
    expect(column('cancelled')).toEqual(['Slow job']);
    expect(column('review')).toEqual(expect.arrayContaining(['Research Mastra (v2)', 'Compare frameworks']));
    expect(column('waiting')).toEqual(['Interrupted']);
    expect(board.columns.flatMap((c) => c.tasks).every((t) => t.departmentId === research.id)).toBe(true);
  });
});
