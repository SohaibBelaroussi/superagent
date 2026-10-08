import type { ConversationMessage, LiveEvent, ToolCallPart } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { type LiveState, liveReducer, reconcile } from '../src/api/conversations';
import { summarizeTool } from '../src/features/conversations/tool-summary';

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
    expect(summarizeTool(tool('c', 'done'), name).title).toBe('Searched the web for “agent memory”');
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
