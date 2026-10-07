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
} from '@superagent/shared';
import { streamSSE } from 'hono/streaming';
import type { ArtifactRow, TaskRow } from '../../db/schema';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import { matchesFilter } from '../../modules/ledger/events';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toTask(t: TaskRow): Task {
  return {
    id: t.id,
    number: t.number,
    departmentId: t.departmentId,
    title: t.title,
    brief: t.brief,
    phase: t.phase,
    priority: t.priority,
    source: t.source,
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
  };
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
  request: {
    params,
    body: {
      required: false,
      content: { 'application/json': { schema: z.object({ reason: z.string().max(500).optional() }) } },
    },
  },
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

const HEARTBEAT_MS = 25_000;
const REPLAY_LIMIT = 1000;

export function registerTaskRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { tasks, dispatch } = deps;

  v1.openapi(listTasks, async (c) => {
    const { departmentId, phase, limit, cursor } = c.req.valid('query');
    const page = await tasks.list({ departmentId, phase, limit, before: cursor });
    return c.json({ items: page.items.map(toTask), nextCursor: page.nextCursor }, 200);
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

  v1.openapi(getTask, async (c) => c.json(toTask(await tasks.get(c.req.valid('param').id)), 200));

  v1.openapi(updateTask, async (c) => {
    const { id } = c.req.valid('param');
    const { phase, ...fields } = c.req.valid('json');
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
    return c.json(toTask(task), 200);
  });

  v1.openapi(messageTask, async (c) => {
    const { message, mode } = c.req.valid('json');
    const task = await tasks.get(c.req.valid('param').id);
    return c.json(toTask(await dispatch.message(task, message, mode, 'owner')), 200);
  });

  v1.openapi(cancelTask, async (c) => {
    const reason = (c.req.valid('json') as { reason?: string } | undefined)?.reason;
    const task = await tasks.get(c.req.valid('param').id);
    return c.json(toTask(await dispatch.cancel(task, reason, 'owner')), 200);
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
    return c.json(
      { columns: columns.map((col) => ({ phase: col.phase, tasks: col.tasks.map(toTask) })) },
      200,
    );
  });

  // Live task events (SSE). Reconnecting clients send Last-Event-ID (EventSource does this itself)
  // and get the gap replayed from the event log before live events resume.
  v1.get('/events', (c) => {
    const lastEventId = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? 0) || 0;
    const filter = { departmentId: c.req.query('departmentId'), taskId: c.req.query('taskId') };
    return streamSSE(c, async (stream) => {
      let lastSent = lastEventId;
      let replaying = true;
      const buffered: TaskEvent[] = [];
      let queue = Promise.resolve();
      const send = (event: TaskEvent) => {
        queue = queue.then(async () => {
          if (event.seq <= lastSent) return;
          lastSent = event.seq;
          await stream.writeSSE({ id: String(event.seq), event: 'task', data: JSON.stringify(event) });
        });
        return queue;
      };
      // Subscribe before replaying so nothing committed in between is lost; duplicates are skipped by seq.
      const unsubscribe = deps.bus.subscribe((event) => {
        if (!matchesFilter(event, filter)) return;
        if (replaying) buffered.push(event);
        else void send(event);
      });
      const heartbeat = setInterval(() => void stream.write(': keep-alive\n\n'), HEARTBEAT_MS);
      const closed = new Promise<void>((resolve) =>
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        }),
      );
      if (lastEventId > 0) {
        for (const event of await tasks.eventsSince(lastEventId, filter, REPLAY_LIMIT)) await send(event);
      }
      replaying = false;
      for (const event of buffered) await send(event);
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ lastEventId: lastSent }) });
      await closed;
    });
  });

  v1.openAPIRegistry.registerPath({
    method: 'get',
    path: '/events',
    tags,
    summary: 'Live task events (Server-Sent Events)',
    description:
      'Streams `task` events (data: TaskEvent, id: seq) and a `ready` event once caught up. Send Last-Event-ID ' +
      '(or ?lastEventId=) to replay what you missed. Filters: ?departmentId=, ?taskId=. Heartbeat comments every 25 s.',
    responses: { 200: { description: 'text/event-stream' } },
  });
}
