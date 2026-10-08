import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionLog } from '../../src/modules/dispatch/decisions';
import { DispatchService } from '../../src/modules/dispatch/service';
import type { TaskService } from '../../src/modules/ledger/service';
import type { MemoryProfiles } from '../../src/modules/memory/profiles';
import type { OrgDirectory } from '../../src/modules/org/directory';

/** The owner's messages to the chief, against a stand-in chief whose thread is busy or idle on demand. */
function setup() {
  const state = { busy: false, failures: 0 };
  const turns: string[][] = [];
  const chief = {
    getActiveThreadRunId: () => (state.busy ? 'run-1' : undefined),
    abortThreadStream: () => state.busy,
    listActiveThreadRuns: () => [],
    stream: async (messages: string[]) => {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error('The storage is down');
      }
      turns.push(messages);
      return { text: Promise.resolve('On it.') };
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const dispatch = new DispatchService({
    mastra: { getAgent: () => chief, listAgents: () => ({}) } as unknown as Mastra,
    decisions: {} as DecisionLog,
    tasks: {} as TaskService,
    directory: {} as OrgDirectory,
    memory: {} as MemoryProfiles,
    logger: logger as unknown as IMastraLogger,
  });
  return { state, turns, logger, dispatch };
}

describe("the owner's messages to the chief", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start a turn when the chief is idle, and wait together for its turn to end when it is busy', async () => {
    const { state, turns, dispatch } = setup();
    expect(await dispatch.messageChief('First')).toBe('started');
    state.busy = true;
    expect(await dispatch.messageChief('Second')).toBe('queued');
    expect(await dispatch.messageChief('Third')).toBe('queued');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(turns).toEqual([['First']]);

    state.busy = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(turns).toEqual([['First'], ['Second', 'Third']]);
  });

  it('keep queued messages when a turn can’t start, and send them on a later try', async () => {
    const { state, turns, logger, dispatch } = setup();
    state.busy = true;
    await dispatch.messageChief('Still there?');
    state.busy = false;
    state.failures = 1;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(turns).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(turns).toEqual([['Still there?']]);
  });

  it('are given up, with an error in the log, when a turn keeps failing to start', async () => {
    const { state, turns, logger, dispatch } = setup();
    state.busy = true;
    await dispatch.messageChief('Hello');
    state.busy = false;
    state.failures = 99;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(turns).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Gave up sending the owner's messages to the chief of staff",
      expect.objectContaining({ count: 1 }),
    );
  });

  it('left when the server stops are logged, and never sent', async () => {
    const { state, turns, logger, dispatch } = setup();
    state.busy = true;
    await dispatch.messageChief('Before the restart');
    await dispatch.close(0);
    state.busy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turns).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "The server stopped before the chief of staff read the owner's messages",
      { count: 1 },
    );
    await expect(dispatch.messageChief('After')).rejects.toMatchObject({ status: 503 });
  });
});
