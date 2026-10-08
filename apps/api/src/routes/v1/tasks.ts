import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type Artifact,
  ArtifactListSchema,
  BoardSchema,
  CreateTaskInputSchema,
  type Task,
  type TaskEvent,
  TaskEventListSchema,
  TaskListSchema,
  TaskMessageInputSchema,
  TaskPhaseSchema,
  TaskSchema,
  UpdateTaskInputSchema,
  type UsageTotals,
} from '@superagent/shared';
import { streamSSE } from 'hono/streaming';
import type { ArtifactRow, TaskRow } from '../../db/schema';
import { ApiError, problem, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import { matchesFilter } from '../../modules/ledger/events';
import { canTransition } from '../../modules/ledger/phases';
import { NO_USAGE, type UsageService } from '../../modules/usage/service';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toTask(t: TaskRow, usage: UsageTotals = NO_USAGE): Task {
  return {
    id: t.id,
    number: t.number,
    departmentId: t.departmentId,
    title: t.title,
    brief: t.brief,
    phase: t.phase,
    priority: t.priority,
    source: t.source,
    scheduleId: t.scheduleId,
    leadAgentId: t.leadAgentId,
    threadId: t.threadId,
    checklist: t.checklist,
    progress: t.progress,
    result: t.result,
    revision: t.revision,
    dueAt: iso(t.dueAt),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    closedAt: iso(t.closedAt),
    usage,
  };
}

/** Tasks as cards: each with its tokens and cost. */
export async function toTasks(usage: UsageService, rows: TaskRow[]): Promise<Task[]> {
  const totals = await usage.forTasks(rows.map((row) => row.id));
  return rows.map((row) => toTask(row, totals.get(row.id)));
}

async function oneTask(usage: UsageService, row: TaskRow): Promise<Task> {
  return (await toTasks(usage, [row]))[0] as Task;
}

function toArtifact(a: ArtifactRow): Artifact {
  return {
    id: a.id,
    taskId: a.taskId,
    kind: a.kind,
    title: a.title,
    content: a.content,
    url: a.url,
    createdAt: a.createdAt.toISOString(),
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});
const params = z.object({ id: z.uuid() });
const tags = ['tasks'];
const notFound = problemResponse('No task with this id');

const listTasks = createRoute({
  method: 'get',
  path: '/tasks',
  tags,
  summary: 'List tasks, newest first',
  request: {
    query: z.object({
      departmentId: z.uuid().optional(),
      phase: TaskPhaseSchema.optional(),
      scheduleId: z.uuid().optional().describe('Tasks a schedule created'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.coerce.number().int().optional().describe('nextCursor from the previous page'),
    }),
  },
  responses: { 200: json(TaskListSchema, 'A page of tasks') },
});

const createTask = createRoute({
  method: 'post',
  path: '/tasks',
  tags,
  summary: 'Create a task for a department',
  description: "By default it goes straight to the department's lead, who starts working and reports back.",
  request: body(CreateTaskInputSchema),
  responses: {
    201: json(TaskSchema, 'Task created (and dispatched)'),
    400: problemResponse('Invalid request'),
    404: problemResponse('Department not found'),
    409: problemResponse('Department archived, or it has no lead to send the task to'),
  },
});

const getTask = createRoute({
  method: 'get',
  path: '/tasks/{id}',
  tags,
  summary: 'Get a task',
  request: { params },
  responses: { 200: json(TaskSchema, 'The task'), 404: notFound },
});

const updateTask = createRoute({
  method: 'patch',
  path: '/tasks/{id}',
  tags,
  summary: 'Edit a task, close it, or send it back to the lead',
  description:
    'phase "done" accepts a task in review; "queued" sends it (back) to the lead; "cancelled" stops it.',
  request: { params, ...body(UpdateTaskInputSchema) },
  responses: {
    200: json(TaskSchema, 'Updated task'),
    404: notFound,
    409: problemResponse('That phase change is not allowed from the current phase'),
  },
});

const messageTask = createRoute({
  method: 'post',
  path: '/tasks/{id}/messages',
  tags,
  summary: 'Message the lead working on a task',
  description: 'Answers a waiting lead, adds instructions, or asks for changes on a task in review.',
  request: { params, ...body(TaskMessageInputSchema) },
  responses: {
    200: json(TaskSchema, 'Task after delivery'),
    404: notFound,
    409: problemResponse('Task closed'),
  },
});

const cancelTask = createRoute({
  method: 'post',
  path: '/tasks/{id}/cancel',
  tags,
  summary: 'Cancel a task',
  description: 'Optional JSON body: `{ "reason": "..." }` (up to 500 characters).',
  request: { params },
  responses: {
    200: json(TaskSchema, 'Cancelled task'),
    404: notFound,
    409: problemResponse('Already closed'),
  },
});

const listEvents = createRoute({
  method: 'get',
  path: '/tasks/{id}/events',
  tags,
  summary: "A task's history",
  request: {
    params,
    query: z.object({
      after: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
  },
  responses: { 200: json(TaskEventListSchema, 'Events, oldest first'), 404: notFound },
});

const listArtifacts = createRoute({
  method: 'get',
  path: '/tasks/{id}/artifacts',
  tags,
  summary: "A task's deliverables",
  request: { params },
  responses: { 200: json(ArtifactListSchema, 'Artifacts'), 404: notFound },
});

const getBoard = createRoute({
  method: 'get',
  path: '/board',
  tags,
  summary: 'The board: open tasks and tasks closed this week, by phase',
  request: { query: z.object({ departmentId: z.uuid().optional() }) },
  responses: { 200: json(BoardSchema, 'Columns by phase') },
});

const CancelBodySchema = z.object({ reason: z.string().max(500).optional() });
const EventFilterSchema = z.object({ departmentId: z.uuid().optional(), taskId: z.uuid().optional() });

const HEARTBEAT_MS = 25_000;
const REPLAY_PAGE = 500;
/** Past this many missed events a client is better off reloading the board (it gets a `reset` event). */
const REPLAY_MAX = 5000;
const SENT_MEMORY = 10_000;

export function registerTaskRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { tasks, dispatch, usage } = deps;

  v1.openapi(listTasks, async (c) => {
    const { departmentId, phase, scheduleId, limit, cursor } = c.req.valid('query');
    const page = await tasks.list({ departmentId, phase, scheduleId, limit, before: cursor });
    return c.json({ items: await toTasks(usage, page.items), nextCursor: page.nextCursor }, 200);
  });

  v1.openapi(createTask, async (c) => {
    const input = c.req.valid('json');
    if (input.dispatch) dispatch.requireLead(input.departmentId);
    const created = await tasks.create(
      {
        departmentId: input.departmentId,
        title: input.title,
        brief: input.brief,
        priority: input.priority,
        dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        source: 'owner',
      },
      'owner',
    );
    const task = input.dispatch ? await dispatch.dispatch(created, 'owner', 'owner') : created;
    return c.json(toTask(task), 201);
  });

  v1.openapi(getTask, async (c) =>
    c.json(await oneTask(usage, await tasks.get(c.req.valid('param').id)), 200),
  );

  v1.openapi(updateTask, async (c) => {
    const { id } = c.req.valid('param');
    const { phase, ...fields } = c.req.valid('json');
    if (phase) {
      // Check the move first, so a refused phase change doesn't leave the field edits behind.
      const current = await tasks.get(id);
      if (!canTransition('owner', current.phase, phase)) {
        throw new ApiError(
          409,
          'invalid_transition',
          `Task #${current.number} can't move from ${current.phase} to ${phase}`,
        );
      }
      if (phase === 'queued') {
        dispatch.requireLead(current.departmentId);
        if (current.phase !== 'inbox') await dispatch.refuseIfApprovalPending(current);
      }
    }
    let task = await tasks.updateFields(
      id,
      {
        ...fields,
        dueAt: fields.dueAt === undefined ? undefined : fields.dueAt ? new Date(fields.dueAt) : null,
      },
      'owner',
    );
    if (phase === 'queued') task = await dispatch.dispatch(task, 'owner', 'owner');
    else if (phase === 'cancelled') task = await dispatch.cancel(task, undefined, 'owner');
    else if (phase === 'done') task = await tasks.transition(id, 'done', 'owner', 'owner');
    return c.json(await oneTask(usage, task), 200);
  });

  v1.openapi(messageTask, async (c) => {
    const { message, mode } = c.req.valid('json');
    const task = await tasks.get(c.req.valid('param').id);
    return c.json(await oneTask(usage, await dispatch.message(task, message, mode, 'owner')), 200);
  });

  v1.openapi(cancelTask, async (c) => {
    const raw = (await c.req.text()).trim();
    let reason: string | undefined;
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ApiError(400, 'validation_failed', 'The body must be JSON like { "reason": "..." }');
      }
      const body = CancelBodySchema.safeParse(parsed);
      if (!body.success)
        throw new ApiError(400, 'validation_failed', 'reason must be text, up to 500 characters');
      reason = body.data.reason;
    }
    const task = await tasks.get(c.req.valid('param').id);
    return c.json(await oneTask(usage, await dispatch.cancel(task, reason, 'owner')), 200);
  });

  v1.openapi(listEvents, async (c) => {
    const { after, limit } = c.req.valid('query');
    return c.json({ items: await tasks.events(c.req.valid('param').id, { after, limit }) }, 200);
  });

  v1.openapi(listArtifacts, async (c) => {
    const rows = await tasks.artifacts(c.req.valid('param').id);
    return c.json({ items: rows.map(toArtifact) }, 200);
  });

  v1.openapi(getBoard, async (c) => {
    const columns = await tasks.board(c.req.valid('query').departmentId);
    const totals = await usage.forTasks(columns.flatMap((col) => col.tasks.map((task) => task.id)));
    return c.json(
      {
        columns: columns.map((col) => ({
          phase: col.phase,
          tasks: col.tasks.map((task) => toTask(task, totals.get(task.id))),
        })),
      },
      200,
    );
  });

  // Live task events (SSE). Reconnecting clients send Last-Event-ID (EventSource does this itself)
  // and get the gap replayed from the event log before live events resume.
  v1.get('/events', (c) => {
    const cursor = (c.req.header('last-event-id') ?? c.req.query('lastEventId'))?.trim();
    const lastEventId = cursor && /^\d+$/.test(cursor) ? Number(cursor) : undefined;
    const parsed = EventFilterSchema.safeParse({
      departmentId: c.req.query('departmentId'),
      taskId: c.req.query('taskId'),
    });
    if (!parsed.success) {
      return problem(c, 400, {
        title: 'Invalid request',
        code: 'validation_failed',
        errors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const filter = parsed.data;
    return streamSSE(c, async (stream) => {
      // Events at or below the floor are not sent: the client has them (Last-Event-ID) or, for a fresh
      // client, they predate the moment it connected.
      let floor = lastEventId ?? 0;
      let lastSent = floor; // highest seq sent: where the replay continues from
      const sent = new Set<number>(); // replayed and live events overlap; send each once
      let replaying = true;
      const buffered: TaskEvent[] = [];
      let queue = Promise.resolve();
      const send = (event: TaskEvent) => {
        queue = queue.then(async () => {
          if (sent.has(event.seq) || event.seq <= floor) return;
          sent.add(event.seq);
          if (sent.size > SENT_MEMORY) sent.delete(sent.values().next().value as number);
          lastSent = Math.max(lastSent, event.seq);
          await stream.writeSSE({ id: String(event.seq), event: 'task', data: JSON.stringify(event) });
        });
        return queue;
      };
      // Subscribe before reading the log, so nothing committed in between is lost.
      const unsubscribe = deps.bus.subscribe((event) => {
        if (!matchesFilter(event, filter)) return;
        if (replaying) buffered.push(event);
        else void send(event);
      });
      const heartbeat = setInterval(() => void stream.write(': keep-alive\n\n'), HEARTBEAT_MS);
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      try {
        if (lastEventId === undefined) {
          // Events commit in seq order (see TaskService), so everything after this one is still to come.
          floor = await tasks.latestSeq();
          lastSent = floor;
        } else {
          let replayed = 0;
          for (;;) {
            const page = await tasks.eventsSince(lastSent, filter, REPLAY_PAGE);
            for (const event of page) await send(event);
            await queue;
            replayed += page.length;
            if (page.length < REPLAY_PAGE) break;
            if (replayed >= REPLAY_MAX) {
              // Too much to catch up on: continue from now; the client reloads the board.
              floor = await tasks.latestSeq();
              lastSent = floor;
              await stream.writeSSE({
                id: String(floor),
                event: 'reset',
                data: JSON.stringify({ reason: 'Too many missed events; reload the board' }),
              });
              break;
            }
          }
        }
        // Flush what arrived meanwhile before going live, so live events can't overtake it.
        while (buffered.length > 0) {
          for (const event of buffered.splice(0)) await send(event);
        }
        replaying = false;
        await queue;
        await stream.writeSSE({
          id: String(lastSent),
          event: 'ready',
          data: JSON.stringify({ lastEventId: lastSent }),
        });
        await closed;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  v1.openAPIRegistry.registerPath({
    method: 'get',
    path: '/events',
    tags,
    summary: 'Live task events (Server-Sent Events)',
    description:
      'Streams `task` events (data: TaskEvent, id: seq), then a `ready` event (with an id to resume from) once ' +
      'caught up. Send Last-Event-ID (or ?lastEventId=) to replay what you missed; after more than 5000 missed ' +
      'events you get a `reset` event instead, so reload the board. Filters: ?departmentId=, ?taskId= (UUIDs). ' +
      'Heartbeat comments every 25 s.',
    responses: { 200: { description: 'text/event-stream' } },
  });
}
