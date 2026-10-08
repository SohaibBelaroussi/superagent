import type {
  ConversationMessage,
  ConversationPage,
  CreatedToken,
  Department,
  LiveEvent,
  Provider,
  Task,
  ToolCallPart,
} from '@superagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { System } from '../../src/bootstrap';
import { type FakeOpenAI, startFakeOpenAI } from '../support/fake-openai';
import { authHeader, jsonHeaders, startTestSystem } from './helpers';

const textOf = (message: ConversationMessage | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
const toolsOf = (messages: ConversationMessage[]) =>
  messages.flatMap((message) => message.parts.filter((part): part is ToolCallPart => part.type === 'tool'));

describe('conversations: the chief and task transcripts', () => {
  let system: System;
  let fake: FakeOpenAI;
  let research: Department;

  const send = (method: string, path: string, body?: unknown, token?: string) =>
    system.app.request(path, {
      method,
      headers: jsonHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const chiefPage = async (query = '') =>
    (await (await send('GET', `/v1/chief/messages${query}`)).json()) as ConversationPage;
  const transcript = async (taskId: string) =>
    (await (await send('GET', `/v1/tasks/${taskId}/transcript?limit=100`)).json()) as ConversationPage;
  const getTask = async (id: string) => (await (await send('GET', `/v1/tasks/${id}`)).json()) as Task;

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting; last value: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Opens a live stream and reads its events one by one. */
  async function openStream(path: string, token?: string) {
    const res = await system.app.request(path, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (!res.body) throw new Error('No stream body');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    /** The next event, or null once the stream has ended. */
    const next = async (): Promise<LiveEvent | null> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = raw.split('\n').find((line) => line.startsWith('data:'));
          if (data) return JSON.parse(data.slice(5).trim()) as LiveEvent;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
      }
    };
    /** Events up to and including the first that matches. */
    const until = async (match: (event: LiveEvent) => boolean, timeoutMs = 15_000) => {
      const seen: LiveEvent[] = [];
      const timeout = setTimeout(() => void reader.cancel(), timeoutMs);
      try {
        for (;;) {
          const event = await next();
          if (!event) throw new Error(`Stream ended after ${JSON.stringify(seen.map((e) => e.type))}`);
          seen.push(event);
          if (match(event)) return seen;
        }
      } finally {
        clearTimeout(timeout);
      }
    };
    return { next, until, close: () => reader.cancel() };
  }

  beforeAll(async () => {
    fake = await startFakeOpenAI(['fake-chat']);
    system = await startTestSystem();
    const provider = (await (
      await send('POST', '/v1/providers', { slug: 'fake', name: 'Fake', baseUrl: fake.url })
    ).json()) as Provider;
    await send('POST', `/v1/providers/${provider.id}/refresh-models`);
    await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    research = (await (
      await send('POST', '/v1/departments', { slug: 'research', name: 'Research', description: 'Finds out.' })
    ).json()) as Department;
    await send('POST', '/v1/agents', {
      key: 'research-lead',
      name: 'Research lead',
      role: 'lead',
      departmentId: research.id,
      description: 'Plans research.',
      instructions: 'Be brief.',
    });
    await send('POST', '/v1/agents', {
      key: 'scout',
      name: 'Scout',
      role: 'specialist',
      departmentId: research.id,
      description: 'Looks things up.',
      instructions: 'Answer in one line.',
    });
  });

  afterAll(async () => {
    await system?.close();
    await fake?.close();
  });

  it('streams the chief’s answer to your message, then keeps both in the history', async () => {
    expect(await chiefPage()).toEqual({ items: [], nextCursor: null });
    const stream = await openStream('/v1/chief/stream');
    expect(await stream.next()).toEqual({ type: 'ready', running: false });

    const sent = await send('POST', '/v1/chief/messages', { message: 'Hello there' });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ delivery: 'started' });

    const events = await stream.until((event) => event.type === 'run-end');
    await stream.close();
    expect(events[0]).toMatchObject({ type: 'run-start', agent: 'chief' });
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'run-end', outcome: 'finished', error: null });
    const streamed = events.flatMap((event) => (event.type === 'text' ? [event.delta] : [])).join('');
    expect(streamed).toBe('pong (fake-chat) Hello there');

    const { items } = await waitFor(chiefPage, (page) => page.items.length >= 2);
    expect(items.map((m) => [m.role, m.author, textOf(m)])).toEqual([
      ['owner', null, 'Hello there'],
      ['agent', 'chief', 'pong (fake-chat) Hello there'],
    ]);
    // The turn names the message its answer is stored as, so a client can swap one for the other.
    expect(end?.type === 'run-end' && end.messageIds).toEqual([items[1]?.id]);
  });

  it('shows the tools the chief used, and the reports it gets, each linked to its task', async () => {
    await send('POST', '/v1/chief/messages', { message: '[assign] Please look into Mastra.' });
    const task = await waitFor(
      async () => (await (await send('GET', '/v1/tasks?limit=1')).json()) as { items: Task[] },
      (page) => page.items[0]?.title === 'Research Mastra',
    ).then((page) => page.items[0] as Task);
    await waitFor(
      () => getTask(task.id),
      (t) => t.phase === 'review',
    );

    const { items } = await waitFor(chiefPage, (page) => page.items.some((m) => m.role === 'report'));
    expect(toolsOf(items).find((part) => part.tool === 'create_task')).toMatchObject({
      status: 'done',
      delegate: null,
      args: { department: 'research', title: 'Research Mastra' },
      result: expect.objectContaining({ task: `#${task.number}`, department: 'research' }),
      error: null,
    });
    expect(items.find((m) => m.role === 'report')).toMatchObject({
      author: null,
      report: {
        kind: 'task-done',
        source: 'dept:research',
        priority: 'medium',
        taskId: task.id,
        taskNumber: task.number,
      },
    });
    expect(textOf(items.find((m) => m.role === 'report'))).toMatch(
      new RegExp(`^#${task.number} Research Mastra`),
    );
  });

  it('holds a message sent while the chief is answering until its turn is over', async () => {
    const first = await send('POST', '/v1/chief/messages', { message: '[slow] First question' });
    expect(await first.json()).toEqual({ delivery: 'started' });
    const second = await send('POST', '/v1/chief/messages', { message: 'Second question' });
    expect(await second.json()).toEqual({ delivery: 'queued' });

    const { items } = await waitFor(chiefPage, (page) => {
      const asked = page.items.findIndex((m) => textOf(m) === 'Second question');
      return asked >= 0 && page.items.slice(asked + 1).some((m) => m.role === 'agent');
    });
    const turns = items.slice(items.findIndex((m) => textOf(m) === '[slow] First question'));
    // The second message went out once the first had been answered, as a turn of its own.
    expect(turns.map((m) => [m.role, m.role === 'owner' ? textOf(m) : m.author])).toEqual([
      ['owner', '[slow] First question'],
      ['agent', 'chief'],
      ['owner', 'Second question'],
      ['agent', 'chief'],
    ]);
  });

  it('stops the chief mid-answer', async () => {
    const stream = await openStream('/v1/chief/stream');
    await stream.until((event) => event.type === 'ready');
    await send('POST', '/v1/chief/messages', { message: '[slow] Take your time' });
    await stream.until((event) => event.type === 'run-start');

    const stopped = await send('POST', '/v1/chief/stop');
    expect(await stopped.json()).toEqual({ stopped: true });
    const ended = (await stream.until((event) => event.type === 'run-end')).at(-1);
    await stream.close();
    expect(ended).toMatchObject({ type: 'run-end', outcome: 'stopped' });
    expect(await (await send('POST', '/v1/chief/stop')).json()).toEqual({ stopped: false });
  });

  it('pages back through the conversation without gaps or repeats', async () => {
    const all = (await chiefPage('?limit=100')).items;
    expect(all.length).toBeGreaterThan(6);
    const paged: ConversationMessage[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
      const page = await chiefPage(query);
      paged.unshift(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    expect(paged.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect((await send('GET', '/v1/chief/messages?before=yesterday')).status).toBe(400);
  });

  it('ends a stream when the token that opened it is revoked', async () => {
    const minted = (await (await send('POST', '/v1/tokens', { name: 'phone' })).json()) as CreatedToken;
    const stream = await openStream('/v1/chief/stream', minted.token);
    expect(await stream.next()).toMatchObject({ type: 'ready' });
    expect((await send('DELETE', `/v1/tokens/${minted.record.id}`)).status).toBe(204);
    expect(await stream.next()).toBeNull();
  });

  it("shows a task's brief, the lead's tool calls with its specialist's answer, and what it was sent", async () => {
    const created = await send('POST', '/v1/tasks', {
      departmentId: research.id,
      title: 'Compare frameworks',
      brief: 'Which agent framework fits us?',
      dispatch: false,
    });
    const task = (await created.json()) as Task;
    expect((await transcript(task.id)).items).toEqual([]);

    const stream = await openStream(`/v1/tasks/${task.id}/stream`);
    expect(await stream.next()).toEqual({ type: 'ready', running: false });
    // A message to a task in the inbox sends it to the lead, with the message as a note.
    await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Keep it short.' });
    const events = await stream.until(
      (event) =>
        event.type === 'tool' && event.part.tool === 'report_to_chief' && event.part.status === 'done',
    );
    await stream.close();
    expect(events[0]).toMatchObject({ type: 'run-start', agent: 'research-lead' });
    const delegation = events.findLast(
      (event): event is Extract<LiveEvent, { type: 'tool' }> =>
        event.type === 'tool' && event.part.delegate !== null,
    );
    expect(delegation?.part).toMatchObject({ tool: 'agent-scout', delegate: 'scout', status: 'done' });
    expect(delegation?.part.result).toEqual(expect.stringContaining('pong'));

    await waitFor(
      () => getTask(task.id),
      (t) => t.phase === 'review',
    );
    const { items } = await waitFor(
      () => transcript(task.id),
      (page) => toolsOf(page.items).some((part) => part.tool === 'report_to_chief'),
    );
    expect(items[0]).toMatchObject({ role: 'brief', author: null });
    expect(textOf(items[0])).toBe('Which agent framework fits us?\n\nNote from the owner: Keep it short.');
    const agentMessages = items.filter((m) => m.role === 'agent');
    expect(new Set(agentMessages.map((m) => m.author))).toEqual(new Set(['research-lead']));
    const tools = toolsOf(items);
    expect(tools.map((part) => part.tool)).toEqual(
      expect.arrayContaining(['update_task', 'agent-scout', 'report_to_chief']),
    );
    expect(tools.find((part) => part.tool === 'agent-scout')).toMatchObject({
      delegate: 'scout',
      status: 'done',
      args: expect.objectContaining({ prompt: expect.any(String) }),
      result: expect.stringContaining('pong'),
    });

    // Sent back with a message: the transcript shows the owner's words, not the prompt around them.
    await send('POST', `/v1/tasks/${task.id}/messages`, { message: 'Add a source, please.' });
    const after = await waitFor(
      () => transcript(task.id),
      (page) => page.items.some((m) => m.role === 'owner'),
    );
    expect(after.items.filter((m) => m.role === 'owner').map(textOf)).toEqual(['Add a source, please.']);
  });

  it('says why the chief couldn’t answer when it has no model', async () => {
    await send('PATCH', '/v1/settings', { models: { default: null } });
    try {
      const stream = await openStream('/v1/chief/stream');
      await stream.until((event) => event.type === 'ready');
      const sent = await send('POST', '/v1/chief/messages', { message: 'Anyone there?' });
      expect(sent.status).toBe(202);
      // A turn that was already under way (the chief reading an earlier report) may still finish first.
      const ended = (
        await stream.until((event) => event.type === 'run-end' && event.outcome !== 'finished')
      ).at(-1);
      await stream.close();
      expect(ended).toMatchObject({ type: 'run-end', outcome: 'failed' });
      expect(ended?.type === 'run-end' && ended.error).toMatch(/model/i);
    } finally {
      await send('PATCH', '/v1/settings', { models: { default: { provider: 'fake', model: 'fake-chat' } } });
    }
  });

  it('answers 404 for a task that does not exist', async () => {
    const missing = '0199b000-0000-7000-8000-ffffffffffff';
    expect((await send('GET', `/v1/tasks/${missing}/transcript`)).status).toBe(404);
    expect((await send('GET', `/v1/tasks/${missing}/stream`)).status).toBe(404);
    const invalid = await send('GET', '/v1/tasks/not-a-task/stream');
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get('content-type')).toContain('application/problem+json');
  });
});
