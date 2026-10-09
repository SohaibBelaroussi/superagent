import type { ConversationMessage, ConversationPage, LiveEvent, ToolCallPart } from '@superagent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationStream,
  conversationMessages,
  type LiveState,
  liveReducer,
  pendingMessage,
  reconcile,
  reportKind,
  splitReport,
  storedPending,
} from '../src/conversations';
import { configureClient, setApiToken } from '../src/http';
import { summarizeTool } from '../src/tools';

const initial: LiveState = { status: 'live', running: false, turns: [], arrived: [] };
const play = (events: LiveEvent[], state = initial, at = 1_000) =>
  events.reduce((current, event) => liveReducer(current, { type: 'event', event, at }), state);

const tool = (
  callId: string,
  status: ToolCallPart['status'],
  extra: Partial<ToolCallPart> = {},
): ToolCallPart => ({
  type: 'tool',
  callId,
  tool: 'web_search',
  delegate: null,
  args: { query: 'agent memory' },
  status,
  error: null,
  ...extra,
});
const agentMessage = (id: string, parts: ConversationMessage['parts']): ConversationMessage => ({
  id,
  createdAt: '2026-10-08T10:00:00.000Z',
  role: 'agent',
  author: 'chief',
  parts,
  report: null,
});
const report: ConversationMessage = {
  id: 'sig-1',
  createdAt: '2026-10-08T10:00:01.000Z',
  role: 'report',
  author: null,
  parts: [{ type: 'text', text: '#3 Proofread: done.' }],
  report: {
    kind: 'task-done',
    source: 'dept:writing',
    priority: 'medium',
    taskId: 't-3',
    taskNumber: 3,
    taskTitle: 'Proofread',
  },
};

describe('a live turn', () => {
  it('is built from its events: text blocks, tool calls by id, and what reached it', () => {
    const state = play([
      { type: 'run-start', runId: 'r1', agent: 'chief' },
      { type: 'answer', runId: 'r1', messageId: 'm1' },
      { type: 'text', runId: 'r1', id: 'text-1', delta: 'Let me ' },
      { type: 'text', runId: 'r1', id: 'text-1', delta: 'check.' },
      { type: 'tool', runId: 'r1', part: tool('c1', 'pending') },
      { type: 'tool', runId: 'r1', part: tool('c1', 'done', { result: { hits: 2 } }) },
      { type: 'message', runId: 'r1', message: report },
      { type: 'text', runId: 'r1', id: 'text-2', delta: 'Done.' },
    ]);
    expect(state.running).toBe(true);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ runId: 'r1', agent: 'chief', messageIds: ['m1'], end: null });
    expect(state.turns[0]?.parts).toEqual([
      { kind: 'text', id: 'text-1', text: 'Let me check.' },
      { kind: 'tool', part: tool('c1', 'done', { result: { hits: 2 } }) },
      { kind: 'message', message: report },
      { kind: 'text', id: 'text-2', text: 'Done.' },
    ]);

    const ended = play(
      [{ type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['m1', 'm2'] }],
      state,
      5_000,
    );
    expect(ended.running).toBe(false);
    expect(ended.turns[0]).toMatchObject({ messageIds: ['m1', 'm2'], endedAt: 5_000 });
  });

  it('keeps what arrives between turns apart, once, and starts over on a new connection', () => {
    const state = play([
      { type: 'message', runId: 'quiet', message: report },
      { type: 'message', runId: 'quiet', message: report },
      { type: 'run-start', runId: 'r1', agent: null },
    ]);
    expect(state.arrived).toEqual([report]);
    const reconnected = play([{ type: 'ready', running: true }], state);
    expect(reconnected.turns).toEqual([]);
    expect(reconnected.running).toBe(true);
  });
});

describe('the history with live turns', () => {
  const live = (events: LiveEvent[], at = 1_000) => play(events, initial, at);

  it('stays whole, takes the live status of its tool calls, and leaves the turn only what it lacks', () => {
    // The history already has the turn's first step (half-written), the turn is on its second.
    const stored = [agentMessage('m1', [tool('c1', 'approval'), { type: 'text', text: 'Searching first.' }])];
    const state = live([
      { type: 'run-start', runId: 'r1', agent: 'chief' },
      { type: 'answer', runId: 'r1', messageId: 'm1' },
      { type: 'text', runId: 'r1', id: 'text-1', delta: 'Searching first.' },
      { type: 'tool', runId: 'r1', part: tool('c1', 'pending') },
      { type: 'tool', runId: 'r1', part: tool('c2', 'pending', { tool: 'fetch_page' }) },
      { type: 'message', runId: 'r1', message: report },
      { type: 'text', runId: 'r1', id: 'text-2', delta: 'Now reading' },
    ]);
    const view = reconcile([...stored, report], state, 500);
    // The stored message stays, with its call's live status; the report shows from the history.
    expect(view.messages[0]?.parts[0]).toEqual(tool('c1', 'pending'));
    expect(view.messages[1]).toEqual(report);
    expect(view.running).toEqual(new Set(['c1', 'c2']));
    // The turn keeps only the new call and the new text.
    expect(view.turns[0]?.parts).toEqual([
      { kind: 'tool', part: tool('c2', 'pending', { tool: 'fetch_page' }) },
      { kind: 'text', id: 'text-2', text: 'Now reading' },
    ]);
    expect(view.turns[0]?.stored).toBe(3);
  });

  it('does not hide text that only looks like an earlier answer', () => {
    const stored = [agentMessage('old', [{ type: 'text', text: 'All good.' }])];
    const state = live([
      { type: 'run-start', runId: 'r2', agent: 'chief' },
      { type: 'answer', runId: 'r2', messageId: 'new' },
      { type: 'text', runId: 'r2', id: 'text-1', delta: 'All good.' },
    ]);
    expect(reconcile(stored, state, 500).turns[0]?.parts).toHaveLength(1);
  });

  it('lets an ended turn go once a history fetched after its end has its answer', () => {
    const state = live(
      [
        { type: 'run-start', runId: 'r1', agent: 'chief' },
        { type: 'text', runId: 'r1', id: 'text-1', delta: 'Hello' },
        { type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['m1'] },
      ],
      2_000,
    );
    const answered = [agentMessage('m1', [{ type: 'text', text: 'Hello' }])];
    // Fetched before the turn ended: it may lack the final answer, so the turn stays.
    expect(reconcile(answered, state, 1_500).turns).toHaveLength(1);
    expect(reconcile([], state, 2_500).turns).toHaveLength(1);
    expect(reconcile(answered, state, 2_500).turns).toEqual([]);
  });
});

describe('tool calls in words', () => {
  const name = (key: string) => (key === 'scout' ? 'Scout' : key);
  it('says what each of our tools did', () => {
    expect(summarizeTool(tool('c', 'done'), name)).toEqual({
      icon: 'Search',
      title: 'Searched the web for “agent memory”',
    });
    expect(
      summarizeTool(
        tool('c', 'done', {
          tool: 'create_task',
          args: { title: 'Proofread' },
          result: { task: '#12' },
        }),
        name,
      ).title,
    ).toBe('Created task #12: Proofread');
    expect(
      summarizeTool(tool('c', 'pending', { tool: 'create_task', args: { title: 'X' } }), name).title,
    ).toBe('Creating “X”');
    expect(summarizeTool(tool('c', 'done', { tool: 'agent-scout', delegate: 'scout' }), name).title).toBe(
      'Asked Scout',
    );
    expect(
      summarizeTool(tool('c', 'done', { tool: 'update_task', args: { progress: 40 } }), name).title,
    ).toBe('Updated the task (40%)');
    expect(
      summarizeTool(
        tool('c', 'done', { tool: 'mastra_workspace_execute_command', args: { command: 'node a.js' } }),
        name,
      ).title,
    ).toBe('Ran node a.js');
    expect(summarizeTool(tool('c', 'done', { tool: 'github_create_issue' }), name).title).toBe(
      'Used github_create_issue',
    );
  });
});

describe('your messages on their way', () => {
  const yours = (id: string, text: string): ConversationMessage => ({
    ...agentMessage(id, [{ type: 'text', text }]),
    role: 'owner',
    author: null,
  });

  it('finds each in the history once it’s stored, even the same words twice', () => {
    const before = [yours('m1', 'Status?')];
    const first = pendingMessage('a', 'Status?', before);
    const second = pendingMessage('b', 'Status?', before);
    // The earlier "Status?" is neither of them.
    expect(storedPending([first, second], before).size).toBe(0);

    const after = [...before, yours('m2', 'Status?')];
    expect(storedPending([first, second], after)).toEqual(new Map([['a', 'm2']]));
    const both = [...after, yours('m3', 'Status?')];
    expect(storedPending([first, second], both)).toEqual(
      new Map([
        ['a', 'm2'],
        ['b', 'm3'],
      ]),
    );
  });
});

describe('reports', () => {
  it('split into the task and what happened, even when the title holds a colon', () => {
    expect(splitReport('#3 Proofread: done.')).toEqual({ number: 3, title: 'Proofread', summary: 'done.' });
    const colon = { ...report.report, taskNumber: 4, taskTitle: 'Plan: Q4' } as ConversationMessage['report'];
    expect(splitReport('#4 Plan: Q4: drafted.', colon)).toEqual({
      number: 4,
      title: 'Plan: Q4',
      summary: 'drafted.',
    });
    expect(splitReport('No task here')).toBeNull();
  });

  it('show their kind, or an update', () => {
    expect(reportKind(report.report)).toEqual({ label: 'Done', tone: 'green', icon: 'CircleCheck' });
    expect(reportKind(null).label).toBe('Update');
  });
});

describe('a conversation’s history', () => {
  it('reads the pages oldest first, each message once', () => {
    const say = (id: string) => agentMessage(id, [{ type: 'text', text: id }]);
    // Newest page first, as they load; the conversation grew between the two, so they overlap.
    const pages: ConversationPage[] = [
      { items: [say('c'), say('d')], nextCursor: '2026-10-08T10:00:00.000Z' },
      { items: [say('a'), say('b'), say('c')], nextCursor: null },
    ];
    expect(conversationMessages(pages).map((message) => message.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(conversationMessages(undefined)).toEqual([]);
  });
});

describe('ConversationStream', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    configureClient({ baseUrl: 'http://superagent.test' });
    setApiToken('sa_device_token');
  });
  afterEach(() => {
    vi.useRealTimers();
    configureClient({ baseUrl: '' });
    setApiToken(null);
  });

  it('passes on the turn and says when the history changed, once more just after a turn ends', async () => {
    let push!: (text: string) => void;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return new Response(body, { status: 200 });
    });
    const events: string[] = [];
    let stale = 0;
    const stream = new ConversationStream(
      { kind: 'task', taskId: 'task-1' },
      'sa_device_token',
      {
        onEvent: (event) => events.push(event.type),
        onStatus: () => {},
        onStale: () => {
          stale += 1;
        },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    stream.start();
    await vi.waitFor(() => expect(urls).toEqual(['http://superagent.test/v1/tasks/task-1/stream']));

    push('event: ready\ndata: {"type":"ready","running":true}\n\n');
    push('event: run-start\ndata: {"type":"run-start","runId":"r1","agent":"lead"}\n\n');
    push('event: text\ndata: {"type":"text","runId":"r1","id":"t1","delta":"Hello"}\n\n');
    // Not a live event: skipped.
    push('event: text\ndata: {"nope":true}\n\n');
    await vi.waitFor(() => expect(events).toEqual(['ready', 'run-start', 'text']));
    expect(stale).toBe(2);

    push(
      'event: run-end\ndata: {"type":"run-end","runId":"r1","outcome":"finished","error":null,"messageIds":["m1"]}\n\n',
    );
    await vi.waitFor(() => expect(events.at(-1)).toBe('run-end'));
    expect(stale).toBe(3);
    // Closing the stream doesn't cancel the second look: the answer may be stored a moment later.
    stream.stop();
    vi.advanceTimersByTime(1500);
    expect(stale).toBe(4);
  });
});
