// M3 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// The ledger, board and live events without a model: lead runs are covered by the integration and live suites.
import type { Board, Department, Task, TaskEvent } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const headers = {
  Authorization: `Bearer ${process.env.SUPERAGENT_ADMIN_TOKEN ?? ''}`,
  'content-type': 'application/json',
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Frame = { event?: string; id?: string; data?: string };

/** Reads an SSE response frame by frame (heartbeat comments skipped). */
function frames(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async (): Promise<Frame> => {
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
}

describe(`M3 against ${BASE_URL}`, () => {
  it('keeps tasks on the board and streams their events, with replay', async () => {
    const suffix = Date.now().toString(36);
    const department = (await (
      await call('POST', '/v1/departments', { slug: `e2e-m3-${suffix}`, name: `E2E M3 ${suffix}` })
    ).json()) as Department;

    // No lead yet: dispatching is refused and nothing is created; parking in the inbox works.
    const refused = await call('POST', '/v1/tasks', { departmentId: department.id, title: 'x', brief: 'y' });
    expect(refused.status).toBe(409);
    const created = await call('POST', '/v1/tasks', {
      departmentId: department.id,
      title: 'Check the ledger',
      brief: 'End-to-end check.',
      dispatch: false,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    expect(task).toMatchObject({ phase: 'inbox', source: 'owner', threadId: `task:${task.id}` });

    const board = (await (await call('GET', `/v1/board?departmentId=${department.id}`)).json()) as Board;
    expect(board.columns.find((c) => c.phase === 'inbox')?.tasks.map((t) => t.id)).toEqual([task.id]);

    const history = (
      (await (await call('GET', `/v1/tasks/${task.id}/events`)).json()) as { items: TaskEvent[] }
    ).items;
    expect(history.map((e) => e.type)).toEqual(['created']);
    const createdSeq = history[0]?.seq ?? 0;

    // Reconnect from just before the task existed: the created event is replayed, then live events follow.
    const abort = new AbortController();
    const stream = await fetch(`${BASE_URL}/v1/events?taskId=${task.id}`, {
      headers: { ...headers, 'Last-Event-ID': String(createdSeq - 1) },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    if (!stream.body) throw new Error('No stream body');
    const next = frames(stream.body);
    try {
      expect(await next()).toMatchObject({ event: 'task', id: String(createdSeq) });
      expect((await next()).event).toBe('ready');

      expect((await call('PATCH', `/v1/tasks/${task.id}`, { title: 'Check the ledger again' })).status).toBe(
        200,
      );
      expect(JSON.parse((await next()).data ?? '{}')).toMatchObject({ type: 'updated', taskId: task.id });

      const cancelled = await call('POST', `/v1/tasks/${task.id}/cancel`, { reason: 'e2e done' });
      expect(await cancelled.json()).toMatchObject({ phase: 'cancelled', closedAt: expect.any(String) });
      expect(JSON.parse((await next()).data ?? '{}')).toMatchObject({
        type: 'phase_changed',
        phase: 'cancelled',
        data: { from: 'inbox', to: 'cancelled', reason: 'e2e done' },
      });
    } finally {
      abort.abort();
    }

    expect((await call('DELETE', `/v1/departments/${department.id}`)).status).toBe(204);
  });
});
