import { type AnyExportedSpan, SpanType } from '@mastra/core/observability';
import { describe, expect, it } from 'vitest';
import { callFromSpan, costOf, type UsageCall } from '../../src/modules/usage/service';

const TASK = '0199c000-0000-7000-8000-000000000001';
const DEPT = '0199c000-0000-7000-8000-0000000000d1';

const span = (overrides: Partial<AnyExportedSpan> & Record<string, unknown>): AnyExportedSpan =>
  ({
    id: 'span-1',
    traceId: 'trace-1',
    name: 'llm: fake-chat',
    type: SpanType.MODEL_INFERENCE,
    startTime: new Date('2026-10-08T10:00:00Z'),
    endTime: new Date('2026-10-08T10:00:02Z'),
    isRootSpan: false,
    isEvent: false,
    entityId: 'research-lead',
    attributes: {
      provider: 'fake.chat',
      model: 'fake-chat',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        inputDetails: { text: 200, cacheRead: 1000 },
        outputDetails: { text: 250, reasoning: 50 },
      },
    },
    metadata: { taskId: TASK, departmentId: DEPT, threadId: `task:${TASK}` },
    ...overrides,
  }) as AnyExportedSpan;

describe('usage from traces', () => {
  it('reads a model request from its MODEL_INFERENCE span, with the task it was made for', () => {
    expect(callFromSpan(span({}))).toEqual({
      traceId: 'trace-1',
      spanId: 'span-1',
      occurredAt: new Date('2026-10-08T10:00:02Z'),
      taskId: TASK,
      departmentId: DEPT,
      agent: 'research-lead',
      provider: 'fake',
      model: 'fake-chat',
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 300,
      reasoningTokens: 50,
    });
  });

  it('falls back to a task thread, and ignores spans without tokens or of other kinds', () => {
    const specialist = callFromSpan(
      span({ metadata: { threadId: `task:${TASK}-0199c000-0000-7000-8000-00000000abcd`, taskId: 'nope' } }),
    );
    expect(specialist).toMatchObject({ taskId: TASK, departmentId: null });
    expect(callFromSpan(span({ metadata: { threadId: 'chief:main' } }))).toMatchObject({ taskId: null });
    expect(callFromSpan(span({ attributes: { model: 'x', usage: {} } }))).toBeUndefined();
    expect(callFromSpan(span({ type: SpanType.MODEL_STEP }))).toBeUndefined();
    expect(callFromSpan(span({ type: SpanType.MODEL_GENERATION }))).toBeUndefined();
    expect(callFromSpan(span({ type: SpanType.AGENT_RUN }))).toBeUndefined();
  });

  it('prices calls per million tokens, cached input at its own price when it has one', () => {
    const call = callFromSpan(span({})) as UsageCall;
    // 200 fresh input at $3, 1000 cached at $0.30, 300 output at $15.
    expect(costOf(call, { inputUsd: 3, cachedInputUsd: 0.3, outputUsd: 15 })).toBeCloseTo(0.0054, 10);
    // Without a cached price, cached input costs the input price.
    expect(costOf(call, { inputUsd: 3, cachedInputUsd: null, outputUsd: 15 })).toBeCloseTo(0.0081, 10);
    expect(costOf(call, undefined)).toBeNull();
  });
});
