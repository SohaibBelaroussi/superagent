import type {
  AgentDefinition,
  AttentionItem,
  Board,
  Department,
  Me,
  Task,
  TaskEvent,
  UsageTotals,
} from '@superagent/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { putInKeystore } from './device';

/** The network boundary: every request the app makes is answered here, or the test fails. */
export const server = setupServer();

/** The server the phone is paired with in these tests. */
export const SERVER = 'http://localhost:4111';
export const api = (path: string) => `${SERVER}${path}`;

export const ADMIN_TOKEN = `sa_${'a'.repeat(43)}`;
export const DEVICE_TOKEN = `sa_${'d'.repeat(43)}`;
export const PAIR_CODE = `sa_pair_${'p'.repeat(43)}`;
export const PHONE = 'App: Pixel 9, Android 16';

export const NO_USAGE: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
};

export function me(tokenId = 'phone-1', tokenName = PHONE): Me {
  return { id: 'owner', name: 'Owner', token: { id: tokenId, name: tokenName }, version: '0.1.0' };
}

export const research: Department = {
  id: '0199a000-0000-7000-8000-000000000001',
  slug: 'research',
  name: 'Research',
  description: 'Finds things out.',
  autoClose: false,
  lead: {
    id: '0199a000-0000-7000-8000-0000000000a1',
    key: 'research-lead',
    name: 'Ada',
    role: 'lead',
    description: 'Leads research.',
  },
  members: [],
  skills: [],
  mcp: [],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  archivedAt: null,
};

export const writing: Department = {
  ...research,
  id: '0199a000-0000-7000-8000-000000000002',
  slug: 'writing',
  name: 'Writing',
  description: 'Writes things.',
  lead: null,
};

export const ada: AgentDefinition = {
  id: '0199a000-0000-7000-8000-0000000000a1',
  key: 'research-lead',
  name: 'Ada',
  role: 'lead',
  departmentId: research.id,
  activeVersion: 1,
  current: {
    version: 1,
    description: 'Leads research.',
    instructions: 'Lead.',
    model: null,
    tools: [],
    skills: [],
    mcp: [],
    createdAt: '2026-10-01T09:00:00.000Z',
  },
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  archivedAt: null,
};

let counter = 0;
export function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  const id = overrides.id ?? `0199b000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
  return {
    id,
    number: counter,
    departmentId: research.id,
    title: `Task ${counter}`,
    brief: 'Do the thing.',
    phase: 'inbox',
    priority: 'normal',
    source: 'owner',
    scheduleId: null,
    leadAgentId: ada.id,
    threadId: `task:${id}`,
    checklist: [],
    progress: null,
    result: null,
    revision: 1,
    dueAt: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    closedAt: null,
    usage: NO_USAGE,
    ...overrides,
  };
}

export function board(tasks: Task[]): Board {
  const phases = ['inbox', 'queued', 'working', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;
  return { columns: phases.map((phase) => ({ phase, tasks: tasks.filter((item) => item.phase === phase) })) };
}

let seq = 0;
export function event(overrides: Partial<TaskEvent> & Pick<TaskEvent, 'type'>): TaskEvent {
  seq += 1;
  return {
    seq,
    taskId: '0199b000-0000-7000-8000-000000000001',
    taskNumber: 1,
    departmentId: research.id,
    actor: 'owner',
    phase: 'queued',
    data: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function approval(target: Task, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: 'approval',
    id: `approval:run-${target.number}:call-1`,
    title: 'Ada wants to run web_search',
    detail: `#${target.number} ${target.title}`,
    taskId: target.id,
    taskNumber: target.number,
    departmentId: target.departmentId,
    agent: 'research-lead',
    tool: 'web_search',
    args: { query: 'agent frameworks' },
    since: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

/** The live stream: says it's ready, then stays open until the test ends. */
function eventStream(frames = 'id: 0\nevent: ready\ndata: {"lastEventId":0}\n\n') {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
    },
  });
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
}

/** An event stream the test writes to, one connection at a time. */
export function liveStream() {
  const connections: Array<{ lastEventId: string | null; send(text: string): void; closed: boolean }> = [];
  const handler = http.get(api('/v1/events'), ({ request }) => {
    const connection = {
      lastEventId: request.headers.get('last-event-id'),
      closed: false,
      send: (_text: string) => {},
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.send = (text) => controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        connection.closed = true;
      },
    });
    request.signal.addEventListener('abort', () => {
      connection.closed = true;
    });
    connections.push(connection);
    return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  return { connections, handler };
}

/** What a signed-in app reads on its screens, over `tasks` and what needs you. */
export function signedInHandlers(options: { tasks?: Task[]; attention?: AttentionItem[] } = {}) {
  const tasks = options.tasks ?? [];
  return [
    http.get(api('/v1/me'), () => HttpResponse.json(me())),
    http.get(api('/v1/departments'), () => HttpResponse.json({ items: [research, writing] })),
    http.get(api('/v1/agents'), () => HttpResponse.json({ items: [ada] })),
    http.get(api('/v1/profile'), () => HttpResponse.json({ name: 'Sohaib Example' })),
    http.get(api('/v1/attention'), () => HttpResponse.json({ items: options.attention ?? [] })),
    http.get(api('/v1/board'), ({ request }) => {
      const department = new URL(request.url).searchParams.get('departmentId');
      return HttpResponse.json(
        board(department ? tasks.filter((item) => item.departmentId === department) : tasks),
      );
    }),
    http.get(api('/v1/usage'), ({ request }) =>
      HttpResponse.json({
        group: new URL(request.url).searchParams.get('group') ?? 'day',
        from: null,
        to: null,
        items: [],
        total: { ...NO_USAGE, costUsd: 0.42, totalTokens: 12_300, calls: 3 },
      }),
    ),
    http.get(api('/v1/tasks/:id'), ({ params }) => {
      const found = tasks.find((item) => item.id === params.id);
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json({ type: 'about:blank', title: 'Not found', status: 404 }, { status: 404 });
    }),
    http.get(api('/v1/tasks/:id/events'), () => HttpResponse.json({ items: [] })),
    http.get(api('/v1/tasks/:id/artifacts'), () => HttpResponse.json({ items: [] })),
    http.get(api('/v1/events'), () => eventStream()),
  ];
}

/** Starts the app paired with SERVER: the keystore holds a session, as after pairing. */
export function signedIn(token = DEVICE_TOKEN): void {
  putInKeystore(
    'superagent.session',
    JSON.stringify({ server: SERVER, token, tokenId: 'phone-1', tokenName: PHONE }),
  );
}
