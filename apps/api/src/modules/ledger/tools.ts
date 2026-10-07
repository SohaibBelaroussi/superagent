import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { ChecklistItemSchema, TaskPrioritySchema } from '@superagent/shared';
import { z } from 'zod';
import type { TaskRow } from '../../db/schema';
import { truncate } from '../../util/text';
import type { DispatchService } from '../dispatch/service';
import type { OrgDirectory } from '../org/directory';
import type { TaskService } from './service';

export interface LedgerToolDeps {
  tasks: TaskService;
  dispatch: DispatchService;
  directory: OrgDirectory;
}

type ToolAgentContext = { agent?: { agentId?: string; threadId?: string; toolCallId?: string } } | undefined;

function summary(task: TaskRow) {
  return {
    task: `#${task.number}`,
    title: task.title,
    phase: task.phase,
    priority: task.priority,
    progress: task.progress,
  };
}

/**
 * The task a lead is working on is the one whose thread the run is in (task:<id>), so these tools also
 * work for runs started by a schedule. A lead can only touch tasks assigned to it.
 */
async function currentTask(deps: LedgerToolDeps, context: ToolAgentContext): Promise<TaskRow> {
  const threadId = context?.agent?.threadId;
  const task = threadId ? await deps.tasks.getByThread(threadId) : undefined;
  if (!task) throw new Error('This conversation is not a task thread, so there is no task to update.');
  const caller = context?.agent?.agentId ? deps.directory.agentByKey(context.agent.agentId) : undefined;
  if (task.leadAgentId && caller && task.leadAgentId !== caller.id) {
    throw new Error(`Task #${task.number} is assigned to another lead.`);
  }
  return task;
}

/**
 * Errors come back to the model as results instead of throwing: a thrown tool error ends the whole
 * Mastra run, while a returned one lets the agent read it and recover (e.g. pick another department).
 */
function returnErrors(tools: ToolsInput): ToolsInput {
  for (const tool of Object.values(tools)) {
    const target = tool as { execute?: (...args: unknown[]) => Promise<unknown> };
    const original = target.execute;
    if (!original) continue;
    target.execute = async (...args: unknown[]) => {
      try {
        return await original.apply(tool, args);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
  }
  return tools;
}

/** Tools every department lead gets, on top of the tools its definition grants. */
export function createLeadTools(deps: LedgerToolDeps): ToolsInput {
  return returnErrors({
    update_task: createTool({
      id: 'update_task',
      description:
        'Update the task you are working on: phase ("working", or "waiting" when you need the owner), ' +
        'progress (0-100), a checklist of steps, and a short note.',
      inputSchema: z.object({
        phase: z.enum(['working', 'waiting']).optional(),
        progress: z.number().int().min(0).max(100).optional(),
        checklist: z.array(ChecklistItemSchema).max(30).optional(),
        note: z.string().max(1000).optional(),
      }),
      execute: async (input, context) => {
        const task = await currentTask(deps, context as ToolAgentContext);
        const updated = await deps.tasks.recordProgress(
          task.id,
          `agent:${context?.agent?.agentId ?? 'lead'}`,
          input,
        );
        return summary(updated);
      },
    }),
    add_artifact: createTool({
      id: 'add_artifact',
      description: 'Attach a deliverable to the task: a text document (markdown) or a link.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        kind: z.enum(['text', 'link']),
        content: z.string().max(100_000).optional().describe('Markdown, for kind "text"'),
        url: z.url().optional().describe('For kind "link"'),
      }),
      execute: async (input, context) => {
        const task = await currentTask(deps, context as ToolAgentContext);
        const artifact = await deps.tasks.addArtifact(
          task.id,
          `agent:${context?.agent?.agentId ?? 'lead'}`,
          input,
        );
        return { artifactId: artifact.id, task: `#${task.number}` };
      },
    }),
    report_to_chief: createTool({
      id: 'report_to_chief',
      description:
        'Finish your work on the task and report to the chief of staff. outcome "done" with the result, ' +
        '"blocked" when you need the owner, "failed" when it cannot be done.',
      inputSchema: z.object({
        outcome: z.enum(['done', 'blocked', 'failed']),
        summary: z.string().min(1).max(1000).describe('One or two sentences for the chief'),
        result: z.string().max(50_000).optional().describe('The full result or deliverable, if any'),
      }),
      execute: async (input, context) => {
        const task = await currentTask(deps, context as ToolAgentContext);
        const updated = await deps.dispatch.report(task, context?.agent?.agentId ?? 'lead', input);
        return { ...summary(updated), reported: true };
      },
    }),
  });
}

/** Tools the chief of staff uses to run the organization. */
export function createChiefTools(deps: LedgerToolDeps): ToolsInput {
  return returnErrors({
    create_task: createTool({
      id: 'create_task',
      description:
        "Assign work to a department. The department's lead starts on it right away and reports back. " +
        'Write a self-contained brief: goal, context, what to deliver.',
      inputSchema: z.object({
        department: z.string().min(1).describe('Department slug, from your list of departments'),
        title: z.string().min(1).max(200),
        brief: z.string().min(1).max(20_000),
        priority: TaskPrioritySchema.optional(),
      }),
      execute: async (input, context) => {
        const department = deps.directory.departments().find((d) => d.slug === input.department);
        if (!department) {
          const known =
            deps.directory
              .departments()
              .map((d) => d.slug)
              .join(', ') || 'none';
          throw new Error(`No department "${input.department}". Departments: ${known}.`);
        }
        deps.dispatch.requireLead(department.id);
        const toolCallId = (context as ToolAgentContext)?.agent?.toolCallId;
        const task = await deps.tasks.create(
          {
            departmentId: department.id,
            title: input.title,
            brief: input.brief,
            priority: input.priority ?? 'normal',
            source: 'chief',
            ...(toolCallId ? { idempotencyKey: `chief:${toolCallId}` } : {}),
          },
          'chief',
        );
        const dispatched =
          task.phase === 'inbox' ? await deps.dispatch.dispatch(task, 'system', 'chief') : task;
        return { ...summary(dispatched), department: department.slug };
      },
    }),
    board_overview: createTool({
      id: 'board_overview',
      description:
        'See open work across departments (or one department): what is queued, in progress, waiting or in review.',
      inputSchema: z.object({ department: z.string().optional().describe('Department slug') }),
      execute: async ({ department }) => {
        const dept = department ? deps.directory.departments().find((d) => d.slug === department) : undefined;
        const columns = await deps.tasks.board(dept?.id);
        return {
          columns: columns
            .filter((c) => c.tasks.length > 0)
            .map((c) => ({
              phase: c.phase,
              tasks: c.tasks.slice(0, 15).map((t) => ({
                ...summary(t),
                department: deps.directory.department(t.departmentId)?.slug,
              })),
            })),
        };
      },
    }),
    inspect_task: createTool({
      id: 'inspect_task',
      description: "Read one task in detail: brief, checklist, the lead's result and recent events.",
      inputSchema: z.object({ task: z.string().describe('Task number like "#12", or its id') }),
      execute: async ({ task: ref }) => {
        const task = await deps.tasks.resolve(ref);
        const events = await deps.tasks.events(task.id, { limit: 200 });
        return {
          ...summary(task),
          department: deps.directory.department(task.departmentId)?.slug,
          brief: truncate(task.brief, 2000),
          checklist: task.checklist,
          result: task.result ? truncate(task.result, 4000) : null,
          recentEvents: events
            .slice(-12)
            .map((e) => ({ type: e.type, actor: e.actor, at: e.createdAt, data: e.data })),
        };
      },
    }),
    message_task: createTool({
      id: 'message_task',
      description: "Send instructions or the owner's answer to the lead working on a task.",
      inputSchema: z.object({
        task: z.string().describe('Task number like "#12", or its id'),
        message: z.string().min(1).max(10_000),
      }),
      execute: async ({ task: ref, message }) => {
        const task = await deps.tasks.resolve(ref);
        const updated = await deps.dispatch.message(task, message, 'steer', 'chief');
        return summary(updated);
      },
    }),
    cancel_task: createTool({
      id: 'cancel_task',
      description: 'Cancel a task the owner no longer wants, stopping any work in progress.',
      inputSchema: z.object({
        task: z.string().describe('Task number like "#12", or its id'),
        reason: z.string().max(500).optional(),
      }),
      execute: async ({ task: ref, reason }) => {
        const task = await deps.tasks.resolve(ref);
        return summary(await deps.dispatch.cancel(task, reason, 'chief'));
      },
    }),
  });
}
