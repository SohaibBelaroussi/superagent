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

/** The network boundary: every request the app makes is answered here, or the test fails. */
export const server = setupServer();

/** jsdom's origin: the app calls the API on its own origin (D44), so these are the URLs it hits. */
export const api = (path: string) => `${window.location.origin}${path}`;

export const ADMIN_TOKEN = `sa_admin_${'a'.repeat(40)}`;
export const DEVICE_TOKEN = `sa_device_${'d'.repeat(40)}`;

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

export function me(tokenId = 'device-1', tokenName = 'Web: Chrome on Windows'): Me {
  return { id: 'owner', name: 'Owner', token: { id: tokenId, name: tokenName } };
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
  return { columns: phases.map((phase) => ({ phase, tasks: tasks.filter((t) => t.phase === phase) })) };
}

export function event(overrides: Partial<TaskEvent> & Pick<TaskEvent, 'type'>): TaskEvent {
  counter += 1;
  return {
    seq: counter,
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

/** The usual signed-in world: the owner, one department with its lead, and these tasks. */
export function signedInHandlers(options: { tasks?: Task[]; attention?: AttentionItem[] } = {}) {
  const tasks = options.tasks ?? [];
  return [
    http.get(api('/v1/me'), () => HttpResponse.json(me())),
    http.get(api('/v1/departments'), () => HttpResponse.json({ items: [research] })),
    http.get(api('/v1/agents'), () => HttpResponse.json({ items: [ada] })),
    http.get(api('/v1/profile'), () => HttpResponse.json({ name: 'Sohaib' })),
    http.get(api('/v1/attention'), () => HttpResponse.json({ items: options.attention ?? [] })),
    http.get(api('/v1/board'), () => HttpResponse.json(board(tasks))),
    http.get(api('/v1/usage'), ({ request }) =>
      HttpResponse.json({
        group: new URL(request.url).searchParams.get('group') ?? 'department',
        from: null,
        to: null,
        items: [],
        total: { ...NO_USAGE, costUsd: 0.42, totalTokens: 12_300, calls: 3 },
      }),
    ),
    // The live stream: answers ready and stays open until the test ends.
    http.get(api('/v1/events'), () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('id: 0\nevent: ready\ndata: {"lastEventId":0}\n\n'));
        },
      });
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
    }),
  ];
}
