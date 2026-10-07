import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CreateScheduleInputSchema,
  type Schedule,
  ScheduleListSchema,
  ScheduleSchema,
  TaskSchema,
  UpdateScheduleInputSchema,
} from '@superagent/shared';
import type { ScheduleRow } from '../../db/schema';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import type { OrgDirectory } from '../../modules/org/directory';
import { toTask } from './tasks';

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toSchedule(row: ScheduleRow, directory: OrgDirectory): Schedule {
  const department = directory.department(row.departmentId);
  return {
    id: row.id,
    departmentId: row.departmentId,
    department: department ? { slug: department.slug, name: department.name } : null,
    title: row.title,
    brief: row.brief,
    priority: row.priority,
    cron: row.cron,
    timezone: row.timezone,
    status: row.status,
    nextFireAt: iso(row.nextFireAt),
    lastFireAt: iso(row.lastFireAt),
    lastTaskId: row.lastTaskId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});
const tags = ['schedules'];
const params = z.object({ id: z.uuid() });
const notFound = problemResponse('No schedule with this id');

const listSchedules = createRoute({
  method: 'get',
  path: '/schedules',
  tags,
  summary: 'List schedules, newest first',
  request: { query: z.object({ departmentId: z.uuid().optional() }) },
  responses: { 200: json(ScheduleListSchema, 'Schedules with their departments') },
});

const createSchedule = createRoute({
  method: 'post',
  path: '/schedules',
  tags,
  summary: 'Set up recurring work for a department',
  description:
    "Each time the cron fires, a task with this brief goes to the department's lead. Times are in your " +
    'timezone (settings) unless given; a schedule fires at most every 5 minutes.',
  request: body(CreateScheduleInputSchema),
  responses: {
    201: json(ScheduleSchema, 'Schedule created'),
    400: problemResponse('Invalid cron or timezone, or too frequent'),
    404: problemResponse('Department not found'),
    409: problemResponse('Department archived'),
  },
});

const getSchedule = createRoute({
  method: 'get',
  path: '/schedules/{id}',
  tags,
  summary: 'Get a schedule',
  request: { params },
  responses: { 200: json(ScheduleSchema, 'The schedule'), 404: notFound },
});

const updateSchedule = createRoute({
  method: 'patch',
  path: '/schedules/{id}',
  tags,
  summary: 'Edit, pause or resume a schedule',
  request: { params, ...body(UpdateScheduleInputSchema) },
  responses: {
    200: json(ScheduleSchema, 'Updated schedule'),
    400: problemResponse('Invalid cron or timezone, or too frequent'),
    404: notFound,
    409: problemResponse('Department archived'),
  },
});

const deleteSchedule = createRoute({
  method: 'delete',
  path: '/schedules/{id}',
  tags,
  summary: 'Delete a schedule (its tasks stay)',
  request: { params },
  responses: { 204: { description: 'Deleted' }, 404: notFound },
});

const runSchedule = createRoute({
  method: 'post',
  path: '/schedules/{id}/run',
  tags,
  summary: 'Fire a schedule now',
  request: { params },
  responses: {
    201: json(TaskSchema, 'The task it created'),
    404: notFound,
    409: problemResponse('Department archived'),
  },
});

export function registerScheduleRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { schedules } = deps;
  const directory = deps.org.directory;

  v1.openapi(listSchedules, async (c) => {
    const rows = await schedules.list({ departmentId: c.req.valid('query').departmentId });
    return c.json({ items: rows.map((row) => toSchedule(row, directory)) }, 200);
  });

  v1.openapi(createSchedule, async (c) =>
    c.json(toSchedule(await schedules.create(c.req.valid('json'), 'owner'), directory), 201),
  );

  v1.openapi(getSchedule, async (c) =>
    c.json(toSchedule(await schedules.get(c.req.valid('param').id), directory), 200),
  );

  v1.openapi(updateSchedule, async (c) =>
    c.json(toSchedule(await schedules.update(c.req.valid('param').id, c.req.valid('json')), directory), 200),
  );

  v1.openapi(deleteSchedule, async (c) => {
    await schedules.remove(c.req.valid('param').id);
    return c.body(null, 204);
  });

  v1.openapi(runSchedule, async (c) =>
    c.json(toTask(await schedules.runNow(c.req.valid('param').id, 'owner')), 201),
  );
}
