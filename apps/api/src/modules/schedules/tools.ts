import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { TaskPrioritySchema } from '@superagent/shared';
import { z } from 'zod';
import type { ScheduleRow } from '../../db/schema';
import type { OrgDirectory } from '../org/directory';
import type { ScheduleService } from './service';

type ToolContext = { agent?: { agentId?: string } } | undefined;

const CRON_HELP =
  "cron has 5 fields: minute hour day-of-month month day-of-week, e.g. '0 9 * * 1-5' for weekdays at 9:00 " +
  "or '30 7 1 * *' for 7:30 on the 1st of each month. Times are in the owner's timezone unless you give " +
  'another IANA timezone. A schedule fires at most every 5 minutes.';

const timing = {
  cron: z.string().min(9).max(100).describe(CRON_HELP),
  timezone: z.string().optional().describe("IANA timezone; the owner's by default"),
  priority: TaskPrioritySchema.optional(),
};

/** Schedule tools: the chief picks any department, a lead manages its own department's schedules. */
export function createScheduleTools(
  schedules: ScheduleService,
  directory: OrgDirectory,
): { chief: ToolsInput; lead: ToolsInput } {
  const summary = (row: ScheduleRow) => ({
    schedule: row.id,
    title: row.title,
    department: directory.department(row.departmentId)?.slug ?? null,
    cron: row.cron,
    timezone: row.timezone,
    status: row.status,
    nextRun: row.nextFireAt
      ? `${new Intl.DateTimeFormat('en-GB', { timeZone: row.timezone, dateStyle: 'full', timeStyle: 'short' }).format(row.nextFireAt)} (${row.timezone})`
      : null,
  });

  const departmentBySlug = (slug: string) => {
    const department = directory.departments().find((d) => d.slug === slug);
    if (!department) {
      const known = directory
        .departments()
        .map((d) => d.slug)
        .join(', ');
      throw new Error(`No department "${slug}". Departments: ${known || 'none'}.`);
    }
    return department;
  };
  const leadOf = (context: unknown) => {
    const key = (context as ToolContext)?.agent?.agentId;
    const agent = key ? directory.agentByKey(key) : undefined;
    if (!agent) throw new Error('Only department leads manage their department schedules.');
    return agent;
  };
  /**
   * A lead may only change its own department's schedules that an agent set up, never the owner's or the
   * chief's: a lead that read something malicious must not be able to rewrite or restart them.
   */
  const ownSchedule = async (id: string, context: unknown) => {
    const row = await schedules.get(id);
    if (row.departmentId !== leadOf(context).departmentId)
      throw new Error('That schedule belongs to another department.');
    if (!row.createdBy.startsWith('agent:'))
      throw new Error(`The ${row.createdBy} set up that schedule: ask the chief of staff to change it.`);
    return row;
  };

  const updateFields = {
    schedule: z.string().describe('Schedule id from list_schedules'),
    title: z.string().min(1).max(200).optional(),
    brief: z.string().min(1).max(20_000).optional(),
    cron: timing.cron.optional(),
    timezone: timing.timezone,
    priority: timing.priority,
  };
  const deleteSchedule = (forLead: boolean) =>
    createTool({
      id: 'delete_schedule',
      description: forLead
        ? 'Delete a schedule you set up, for good. Tasks it already created stay.'
        : 'Delete a schedule for good. Tasks it already created stay.',
      inputSchema: z.object({ schedule: z.string() }),
      execute: async ({ schedule }, context) => {
        if (forLead) await ownSchedule(schedule, context);
        await schedules.remove(schedule);
        return { deleted: schedule };
      },
    });

  return {
    chief: {
      create_schedule: createTool({
        id: 'create_schedule',
        description: `Set up recurring work for a department: each time the schedule fires, a task with this brief goes to the department's lead. ${CRON_HELP}`,
        inputSchema: z.object({
          department: z.string().describe('Department slug'),
          title: z.string().min(1).max(200),
          brief: z.string().min(1).max(20_000).describe('What the task asks for, each time'),
          ...timing,
        }),
        execute: async ({ department, title, brief, cron, timezone, priority }) =>
          summary(
            await schedules.create(
              {
                departmentId: departmentBySlug(department).id,
                title,
                brief,
                cron,
                timezone,
                priority: priority ?? 'normal',
              },
              'chief',
            ),
          ),
      }),
      list_schedules: createTool({
        id: 'list_schedules',
        description: 'List schedules, for all departments or one.',
        inputSchema: z.object({ department: z.string().optional().describe('Department slug') }),
        execute: async ({ department }) => ({
          schedules: (
            await schedules.list({ departmentId: department ? departmentBySlug(department).id : undefined })
          ).map(summary),
        }),
      }),
      update_schedule: createTool({
        id: 'update_schedule',
        description:
          "Change a schedule's brief, timing or priority, or pause it (status 'paused') and resume it ('active').",
        inputSchema: z.object({ ...updateFields, status: z.enum(['active', 'paused']).optional() }),
        execute: async ({ schedule, ...patch }) => summary(await schedules.update(schedule, patch)),
      }),
      delete_schedule: deleteSchedule(false),
      run_schedule: createTool({
        id: 'run_schedule',
        description:
          "Fire a schedule now: its task goes to the department's lead right away. At most once every 5 minutes per schedule.",
        inputSchema: z.object({ schedule: z.string() }),
        execute: async ({ schedule }) => {
          const task = await schedules.runNow(schedule, 'chief');
          return { task: `#${task.number}`, phase: task.phase };
        },
      }),
    },
    lead: {
      create_schedule: createTool({
        id: 'create_schedule',
        description: `Set up recurring work for your department: each time the schedule fires, a task with this brief comes to you. ${CRON_HELP}`,
        inputSchema: z.object({
          title: z.string().min(1).max(200),
          brief: z.string().min(1).max(20_000).describe('What the task asks for, each time'),
          ...timing,
        }),
        execute: async ({ title, brief, cron, timezone, priority }, context) => {
          const lead = leadOf(context);
          return summary(
            await schedules.create(
              {
                departmentId: lead.departmentId,
                title,
                brief,
                cron,
                timezone,
                priority: priority ?? 'normal',
              },
              `agent:${lead.key}`,
            ),
          );
        },
      }),
      list_schedules: createTool({
        id: 'list_schedules',
        description: "List your department's schedules.",
        inputSchema: z.object({}),
        execute: async (_input, context) => ({
          schedules: (await schedules.list({ departmentId: leadOf(context).departmentId })).map(summary),
        }),
      }),
      update_schedule: createTool({
        id: 'update_schedule',
        description:
          "Change a schedule you set up: its brief, timing or priority, or pause it (status 'paused'). Only the owner or the chief of staff can resume one.",
        inputSchema: z.object({ ...updateFields, status: z.literal('paused').optional() }),
        execute: async ({ schedule, ...patch }, context) => {
          await ownSchedule(schedule, context);
          return summary(await schedules.update(schedule, patch));
        },
      }),
      delete_schedule: deleteSchedule(true),
    },
  };
}
