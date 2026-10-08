import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUnauthorized } from '../src/api/client';
import { EventStream, type LiveStatus, parseFrame } from '../src/api/events';

/** A response whose body the test writes, chunk by chunk, like a server sending events. */
function sse(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(status === 200 ? body : null, { status }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const taskEvent = (seq: number) =>
  JSON.stringify({
    seq,
    taskId: '0199b000-0000-7000-8000-000000000001',
    taskNumber: 1,
    departmentId: '0199a000-0000-7000-8000-000000000001',
    type: 'progress',
    actor: 'agent:research-lead',
    phase: 'working',
    data: { progress: 40 },
    createdAt: '2026-10-08T12:00:00.000Z',
  });

describe('parseFrame', () => {
  it('reads fields and joins data lines', () => {
    expect(parseFrame('id: 7\nevent: task\ndata: {"a":1}')).toEqual({
      id: '7',
      event: 'task',
      data: '{"a":1}',
    });
    expect(parseFrame('data: one\ndata: two')).toEqual({ data: 'one\ntwo' });
  });
  it('treats comments (heartbeats) as nothing', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
  });
});

describe('EventStream', () => {
  const connections: Array<{ headers: Record<string, string>; stream: ReturnType<typeof sse> }> = [];
  let statuses: LiveStatus[];
  let events: number[];
  let resets: number;
  let next: Array<() => ReturnType<typeof sse>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    connections.length = 0;
    statuses = [];
    events = [];
    resets = 0;
    next = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    onUnauthorized(null);
  });

  function start() {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const stream = (next.shift() ?? (() => sse()))();
      connections.push({ headers: init?.headers as Record<string, string>, stream });
      return stream.response;
    });
    const live = new EventStream(
      'sa_device_token',
      {
        onEvent: (event) => events.push(event.seq),
        onReset: () => {
          resets += 1;
        },
        onStatus: (status) => statuses.push(status),
      },
      fetchImpl as unknown as typeof fetch,
    );
    live.start();
    return live;
  }

  it('sends the token in a header, goes live on ready, and passes on task events', async () => {
    const live = start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const first = connections[0];
    expect(first?.headers.authorization).toBe('Bearer sa_device_token');
    expect(first?.headers['last-event-id']).toBeUndefined();

    first?.stream.push('id: 41\nevent: ready\ndata: {"lastEventId":41}\n\n');
    await vi.waitFor(() => expect(statuses).toEqual(['live']));

    // A frame split across chunks, CRLF line breaks, and a heartbeat in between.
    first?.stream.push(`id: 42\r\nevent: task\r\ndata: ${taskEvent(42).slice(0, 20)}`);
    first?.stream.push(`${taskEvent(42).slice(20)}\r\n\r\n: keep-alive\n\n`);
    await vi.waitFor(() => expect(events).toEqual([42]));
    live.stop();
  });

  it('reconnects from the last event it saw, so the server replays the gap', async () => {
    const live = start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]?.stream.push(`id: 42\nevent: task\ndata: ${taskEvent(42)}\n\n`);
    await vi.waitFor(() => expect(events).toEqual([42]));
    connections[0]?.stream.end();

    await vi.waitFor(() => expect(statuses).toContain('offline'));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[1]?.headers['last-event-id']).toBe('42');
    live.stop();
  });

  it('reloads everything on reset', async () => {
    const live = start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]?.stream.push('id: 900\nevent: reset\ndata: {"reason":"Too many missed events"}\n\n');
    await vi.waitFor(() => expect(resets).toBe(1));
    live.stop();
  });

  it('stops on a refused token and signs out', async () => {
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    next.push(() => sse(401));
    start();
    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(1);
  });
});
