import { describe, expect, it } from 'vitest';
import {
  LiveNormalizer,
  normalizeMessage,
  preview,
  reportNumbers,
  type StoredMessage,
  type ThreadContext,
} from '../../src/modules/conversations/normalize';
import { briefFor, readLeadInput, relayedMessage } from '../../src/modules/dispatch/wording';

const at = '2026-10-08T06:09:48.111Z';
const chief: ThreadContext = {
  kind: 'chief',
  authorAt: () => 'chief',
  tasks: new Map([[2, { id: 'task-2', title: 'Find papers' }]]),
  waiting: new Set(),
};
const task: ThreadContext = {
  kind: 'task',
  authorAt: (when) => (when.getTime() < Date.parse('2026-10-08T07:00:00Z') ? 'research-lead' : 'new-lead'),
  tasks: new Map(),
  waiting: new Set(['c-waiting']),
};
const stored = (message: Partial<StoredMessage> & { content: unknown }): StoredMessage => ({
  id: 'm1',
  role: 'user',
  createdAt: new Date(at),
  ...message,
});
const text = (value: string) => ({ format: 2, parts: [{ type: 'text', text: value }] });
const notification = (summary: string, metadata: Record<string, unknown> = {}) =>
  stored({
    role: 'signal',
    type: 'notification',
    content: {
      format: 2,
      parts: [{ type: 'text', text: summary }],
      metadata: {
        signal: {
          type: 'notification',
          tagName: 'notification',
          attributes: { source: 'dept:research', kind: 'task-done', priority: 'medium', status: 'delivered' },
          metadata: { ...metadata, notification: { kind: 'task-done' } },
        },
      },
    },
  });
const toolMessage = (toolInvocation: Record<string, unknown>) =>
  stored({
    role: 'assistant',
    content: { format: 2, parts: [{ type: 'tool-invocation', toolInvocation }] },
  });

describe('stored messages, as clients see them', () => {
  it('shows the owner, the chief and notices, and skips what is empty or meant for agents only', () => {
    expect(normalizeMessage(stored({ content: text('Hello') }), chief)).toEqual({
      id: 'm1',
      createdAt: at,
      role: 'owner',
      author: null,
      parts: [{ type: 'text', text: 'Hello' }],
      report: null,
    });
    expect(normalizeMessage(stored({ role: 'assistant', content: text('Hi') }), chief)).toMatchObject({
      role: 'agent',
      author: 'chief',
    });
    expect(
      normalizeMessage(stored({ role: 'assistant', content: { format: 2, parts: [] } }), chief),
    ).toBeNull();
    expect(normalizeMessage(stored({ role: 'system', content: text('You are…') }), chief)).toBeNull();
    const summary = stored({
      role: 'signal',
      type: 'notification-summary',
      content: {
        ...text('dept:research: 1, dept:writing: 2'),
        metadata: {
          signal: {
            tagName: 'notification-summary',
            metadata: {
              notification: {
                signal: 'summary',
                pending: 3,
                groups: [
                  { source: 'dept:research', count: 1 },
                  { source: 'dept:writing', count: 2 },
                ],
              },
            },
          },
        },
      },
    });
    // The chief may answer a summary, so it shows: in words.
    expect(normalizeMessage(summary, chief)).toMatchObject({
      role: 'note',
      parts: [{ type: 'text', text: '3 updates from research, writing on the way' }],
    });
    const reminder = stored({
      role: 'signal',
      type: 'system-reminder',
      content: {
        ...text('Remember the tools'),
        metadata: { signal: { type: 'reactive', tagName: 'system-reminder' } },
      },
    });
    expect(normalizeMessage(reminder, chief)).toBeNull();
  });

  it('links reports to their task: from their metadata, or from the number older ones start with', () => {
    expect(
      normalizeMessage(
        notification('#7 Proofread: the post: done.', {
          taskId: 'task-7',
          taskNumber: 7,
          taskTitle: 'Proofread: the post',
        }),
        chief,
      ),
    ).toMatchObject({
      role: 'report',
      parts: [{ type: 'text', text: '#7 Proofread: the post: done.' }],
      report: {
        kind: 'task-done',
        source: 'dept:research',
        priority: 'medium',
        taskId: 'task-7',
        taskNumber: 7,
        taskTitle: 'Proofread: the post',
      },
    });
    const older = notification('#2 Find papers: five found.');
    expect(
      reportNumbers([
        older,
        notification('#7 x: y', { taskId: 'task-7', taskTitle: 'x' }),
        notification('#8 z: w', { taskId: 'task-8' }),
      ]),
    ).toEqual([2, 8]);
    expect(normalizeMessage(older, chief)?.report).toMatchObject({
      taskId: 'task-2',
      taskNumber: 2,
      taskTitle: 'Find papers',
    });
    expect(normalizeMessage(notification('#9 Unknown'), chief)?.report).toMatchObject({
      taskId: null,
      taskNumber: 9,
      taskTitle: null,
    });
  });

  it("reads a lead's thread back: the brief, the owner's and the chief's words, and the lead then", () => {
    const brief = briefFor(
      { number: 4, title: 'Draft', brief: 'Write the weekly update.' },
      'Keep it short.',
    );
    expect(normalizeMessage(stored({ content: text(brief) }), task)).toMatchObject({
      role: 'brief',
      parts: [{ type: 'text', text: 'Write the weekly update.\n\nNote from the owner: Keep it short.' }],
    });
    const fromOwner = stored({ content: text(relayedMessage('owner', 4, 'Add sources.')) });
    expect(normalizeMessage(fromOwner, task)).toMatchObject({
      role: 'owner',
      author: null,
      parts: [{ type: 'text', text: 'Add sources.' }],
    });
    // A message steered into a running turn is a signal; the chief can write on the owner's behalf.
    const steered = stored({
      role: 'signal',
      type: 'user',
      content: {
        ...text(relayedMessage('chief', 4, 'The owner wants it today.')),
        metadata: { signal: { type: 'user', tagName: 'user', attributes: { from: 'chief' } } },
      },
    });
    expect(normalizeMessage(steered, task)).toMatchObject({ role: 'agent', author: 'chief' });
    expect(normalizeMessage(stored({ content: text('Something else') }), task)).toMatchObject({
      role: 'note',
    });
    const later = stored({ role: 'assistant', createdAt: '2026-10-08T08:00:00Z', content: text('On it.') });
    expect(normalizeMessage(later, task)).toMatchObject({ author: 'new-lead' });
    expect(normalizeMessage(stored({ role: 'assistant', content: text('Hi') }), task)?.author).toBe(
      'research-lead',
    );
  });

  it('gives each tool call a status, and a delegation the answer of the specialist', () => {
    const call = { toolCallId: 'c1', toolName: 'web_search', args: { query: 'mastra' } };
    const statusOf = (extra: Record<string, unknown>) =>
      normalizeMessage(toolMessage({ ...call, ...extra }), task)?.parts[0];
    expect(statusOf({ state: 'call' })).toEqual({
      type: 'tool',
      callId: 'c1',
      tool: 'web_search',
      delegate: null,
      args: { query: 'mastra' },
      status: 'pending',
      error: null,
    });
    expect(statusOf({ state: 'result', result: { hits: 3 } })).toMatchObject({
      status: 'done',
      result: { hits: 3 },
    });
    expect(statusOf({ state: 'result', isError: true, result: 'timeout' })).toMatchObject({
      status: 'failed',
      error: 'timeout',
    });
    expect(statusOf({ state: 'output-error', errorText: 'boom' })).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
    expect(statusOf({ state: 'approval-requested' })).toMatchObject({ status: 'approval' });
    // Mastra stores a call waiting for approval as plainly called: the waiting list tells.
    expect(statusOf({ state: 'call', toolCallId: 'c-waiting' })).toMatchObject({ status: 'approval' });
    expect(statusOf({ state: 'approval-responded', approval: { id: 'a', approved: true } })).toMatchObject({
      status: 'pending',
    });
    expect(
      statusOf({ state: 'approval-responded', approval: { id: 'a', approved: false, reason: 'No' } }),
    ).toMatchObject({ status: 'declined', error: 'No' });
    expect(statusOf({ state: 'output-denied', approval: { id: 'a', reason: 'Not now' } })).toMatchObject({
      status: 'declined',
      error: 'Not now',
    });

    const delegation = normalizeMessage(
      toolMessage({
        toolCallId: 'c2',
        toolName: 'agent-scout',
        state: 'result',
        args: { prompt: 'Find two sources', __mastraMetadata: { isNetwork: false } },
        result: { text: 'Here are two sources.', subAgentThreadId: 't', subAgentToolResults: [] },
      }),
      task,
    )?.parts[0];
    expect(delegation).toMatchObject({
      tool: 'agent-scout',
      delegate: 'scout',
      args: { prompt: 'Find two sources' },
      result: 'Here are two sources.',
    });
  });

  it('cuts large arguments and results down to a preview', () => {
    const big = { text: 'x'.repeat(10_000) };
    const part = normalizeMessage(
      toolMessage({ toolCallId: 'c3', toolName: 'fetch_page', state: 'result', args: big, result: big }),
      task,
    )?.parts[0];
    expect(part).toMatchObject({ type: 'tool' });
    if (part?.type !== 'tool') return;
    expect(typeof part.args).toBe('string');
    expect((part.args as string).length).toBe(4_000);
    expect((part.args as string).endsWith('…')).toBe(true);
    expect(preview({ small: true })).toEqual({ small: true });
    expect(preview('y'.repeat(5_000))).toHaveLength(4_000);
  });

  it('keeps reasoning, sources, files and errors, and drops step markers', () => {
    const message = stored({
      role: 'assistant',
      content: {
        format: 2,
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: 'Thinking it over' }] },
          { type: 'text', text: 'Answer' },
          {
            type: 'source',
            source: { sourceType: 'url', id: 's', url: 'https://mastra.ai', title: 'Mastra' },
          },
          { type: 'file', mimeType: 'image/png', data: 'AAAA' },
          { type: 'error', error: { name: 'AI_APICallError', message: 'Cannot connect to API' } },
          { type: 'data-progress', data: {} },
        ],
      },
    });
    expect(normalizeMessage(message, chief)?.parts).toEqual([
      { type: 'reasoning', text: 'Thinking it over' },
      { type: 'text', text: 'Answer' },
      { type: 'source', url: 'https://mastra.ai', title: 'Mastra' },
      { type: 'file', name: null, mediaType: 'image/png' },
      { type: 'error', message: 'Cannot connect to API' },
    ]);
  });
});

describe('live chunks, as clients see them', () => {
  const chunk = (runId: string, type: string, payload: Record<string, unknown> = {}) => ({
    runId,
    from: 'AGENT',
    type,
    payload,
  });

  it('announces a run once, splits its text around tool calls, and ends it once', () => {
    const live = new LiveNormalizer(chief);
    const events = [
      chunk('r1', 'start', { id: 'chief', messageId: 'm-1' }),
      chunk('r1', 'step-start', { messageId: 'm-1' }),
      chunk('r1', 'text-start', { id: '0' }),
      chunk('r1', 'text-delta', { id: '0', text: 'Let me ' }),
      chunk('r1', 'text-delta', { id: '0', text: 'check.' }),
      chunk('r1', 'tool-call', { toolCallId: 'c1', toolName: 'board_overview', args: {} }),
      chunk('r1', 'tool-result', { toolCallId: 'c1', toolName: 'board_overview', result: { open: 2 } }),
      // After a message reached it, the run answers under a new id.
      chunk('r1', 'step-start', { messageId: 'm-2' }),
      chunk('r1', 'text-delta', { id: '0', text: 'Two open.' }),
      chunk('r1', 'finish', { messageId: 'm-2', stepResult: { reason: 'stop' } }),
      chunk('r1', 'finish', { stepResult: { reason: 'stop' } }),
      chunk('r1', 'text-delta', { id: '0', text: 'late' }),
    ].flatMap((c) => live.push(c));
    expect(events).toEqual([
      { type: 'run-start', runId: 'r1', agent: 'chief' },
      { type: 'answer', runId: 'r1', messageId: 'm-1' },
      { type: 'text', runId: 'r1', id: 'text-1', delta: 'Let me ' },
      { type: 'text', runId: 'r1', id: 'text-1', delta: 'check.' },
      {
        type: 'tool',
        runId: 'r1',
        part: {
          type: 'tool',
          callId: 'c1',
          tool: 'board_overview',
          delegate: null,
          args: {},
          status: 'pending',
          error: null,
        },
      },
      {
        type: 'tool',
        runId: 'r1',
        part: expect.objectContaining({ callId: 'c1', status: 'done', result: { open: 2 } }),
      },
      { type: 'answer', runId: 'r1', messageId: 'm-2' },
      { type: 'text', runId: 'r1', id: 'text-2', delta: 'Two open.' },
      { type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['m-1', 'm-2'] },
    ]);
  });

  it('tells how a run ended: stopped, failed, or waiting for an approval', () => {
    const live = new LiveNormalizer(task);
    const out = [
      chunk('r1', 'abort'),
      chunk('r2', 'error', { error: { message: 'Cannot connect to API' } }),
      chunk('r3', 'tool-call-approval', { toolCallId: 'c9', toolName: 'web_search', args: { query: 'x' } }),
      chunk('r3', 'finish', { stepResult: { reason: 'suspended' } }),
      chunk('r4', 'text-delta', { text: 'Starting' }),
      chunk('r5', 'start'),
    ].flatMap((c) => live.push(c));
    expect(out.filter((e) => e.type === 'run-end')).toEqual([
      { type: 'run-end', runId: 'r1', outcome: 'stopped', error: null, messageIds: [] },
      { type: 'run-end', runId: 'r2', outcome: 'failed', error: 'Cannot connect to API', messageIds: [] },
      { type: 'run-end', runId: 'r3', outcome: 'suspended', error: null, messageIds: [] },
      // A run whose end never came is over once the next one starts.
      { type: 'run-end', runId: 'r4', outcome: 'finished', error: null, messageIds: [] },
    ]);
    expect(out.find((e) => e.type === 'tool')).toMatchObject({
      part: { status: 'approval', args: { query: 'x' } },
    });
  });

  it('keeps a run that waits for an approval open, so the rest of it comes through after the decision', () => {
    const live = new LiveNormalizer(task);
    const out = [
      chunk('r1', 'start', { id: 'research-lead', messageId: 'm-1' }),
      chunk('r1', 'tool-call', { toolCallId: 'c1', toolName: 'web_search', args: { query: 'x' } }),
      chunk('r1', 'tool-call-approval', { toolCallId: 'c1', toolName: 'web_search', args: { query: 'x' } }),
      // Mastra ends the paused run's stream without a finish; something else happens on the thread.
      chunk('p1', 'start', { messageId: 'persisted-signal:s1' }),
      chunk('p1', 'finish', { stepResult: { reason: 'stop' } }),
      // Approved: the run carries on under its id.
      chunk('r1', 'tool-result', { toolCallId: 'c1', toolName: 'web_search', result: { hits: 3 } }),
      chunk('r1', 'text-delta', { text: 'Found three.' }),
      chunk('r1', 'finish', { messageId: 'm-1', stepResult: { reason: 'stop' } }),
    ].flatMap((c) => live.push(c));
    expect(out.filter((e) => e.type === 'run-end')).toEqual([
      { type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['m-1'] },
    ]);
    expect(out.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.part.status)).toEqual([
      'pending',
      'approval',
      'done',
    ]);
    expect(out).toContainEqual({ type: 'text', runId: 'r1', id: expect.any(String), delta: 'Found three.' });
  });

  it('passes on what reaches the agent; a report that woke no run comes without one', () => {
    const live = new LiveNormalizer(chief);
    const report = {
      id: 'sig-1',
      type: 'notification',
      tagName: 'notification',
      contents: '#3 Proofread: done.',
      createdAt: at,
      attributes: { source: 'dept:writing', kind: 'task-done', priority: 'medium' },
      metadata: { taskId: 'task-3', taskNumber: 3, taskTitle: 'Proofread' },
    };
    const quiet = [
      chunk('p1', 'start', { messageId: 'persisted-signal:sig-1' }),
      { type: 'data-signal', data: report, transient: true, runId: 'p1' },
      chunk('p1', 'finish', { stepResult: { reason: 'stop' } }),
    ].flatMap((c) => live.push(c));
    expect(quiet).toEqual([
      {
        type: 'message',
        runId: 'p1',
        message: {
          id: 'sig-1',
          createdAt: at,
          role: 'report',
          author: null,
          parts: [{ type: 'text', text: '#3 Proofread: done.' }],
          report: {
            kind: 'task-done',
            source: 'dept:writing',
            priority: 'medium',
            taskId: 'task-3',
            taskNumber: 3,
            taskTitle: 'Proofread',
          },
        },
      },
    ]);

    const lead = new LiveNormalizer(task);
    const steered = lead.push({
      type: 'data-user-message',
      runId: 'r7',
      data: {
        id: 'sig-2',
        type: 'user',
        tagName: 'user',
        contents: [{ type: 'text', text: relayedMessage('owner', 5, 'Use the 2025 numbers.') }],
        createdAt: at,
      },
    });
    expect(steered).toEqual([
      { type: 'run-start', runId: 'r7', agent: null },
      {
        type: 'message',
        runId: 'r7',
        message: expect.objectContaining({
          role: 'owner',
          parts: [{ type: 'text', text: 'Use the 2025 numbers.' }],
        }),
      },
    ]);
  });
});

describe('what leads are sent', () => {
  it('reads back as the brief and the message, without the prompt around them', () => {
    expect(readLeadInput(briefFor({ number: 1, title: 'T', brief: 'Do it.' }))).toEqual({
      kind: 'brief',
      text: 'Do it.',
    });
    expect(readLeadInput(relayedMessage('chief', 1, 'Line one\n\nLine two'))).toEqual({
      kind: 'message',
      from: 'chief',
      text: 'Line one\n\nLine two',
    });
    expect(readLeadInput('Task 1: not ours')).toBeNull();
  });
});
