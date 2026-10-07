import type { ChecklistItem, TaskEvent, TaskPhase, TaskPriority } from '@superagent/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import {
  type ArtifactRow,
  artifacts,
  type TaskEventRow,
  type TaskRow,
  taskEvents,
  tasks,
} from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { OrgDirectory } from '../org/directory';
import type { EventBus, EventFilter } from './events';
import { BOARD_PHASES, canTransition, OPEN_PHASES, type PhaseActor, TERMINAL_PHASES } from './phases';

export interface NewTask {
  departmentId: string;
  title: string;
  brief: string;
  priority: TaskPriority;
  dueAt?: Date;
  source: 'owner' | 'chief' | 'schedule';
  /** Repeated calls with the same key return the first task (e.g. a tool call replayed after a restart). */
  idempotencyKey?: string;
}

type PendingEvent = { type: string; data: Record<string, unknown> };
type Change = { patch: Partial<typeof tasks.$inferInsert>; events: PendingEvent[] } | null;

const CLOSED_TASKS_ON_BOARD_MS = 7 * 24 * 60 * 60 * 1000;

function toEvent(row: TaskEventRow, task: Pick<TaskRow, 'number' | 'departmentId'>): TaskEvent {
  return {
    seq: row.seq,
    taskId: row.taskId,
    taskNumber: task.number,
    departmentId: task.departmentId,
    type: row.type,
    actor: row.actor,
    phase: row.phase as TaskPhase,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The task ledger. Every change runs as one locked read-modify-write that also appends to the event log;
 * events are published to live streams only after the transaction commits.
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly directory: OrgDirectory,
    private readonly bus: EventBus,
  ) {}

  async create(input: NewTask, actor: string): Promise<TaskRow> {
    const department = this.directory.department(input.departmentId);
    if (!department)
      throw new ApiError(404, 'department_not_found', `No department with id ${input.departmentId}`);
    if (department.archivedAt) throw new ApiError(409, 'department_archived', 'This department is archived');
    if (input.idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.idempotencyKey, input.idempotencyKey));
      if (existing) return existing;
    }

    const id = uuidv7();
    const { task, events } = await this.db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          id,
          departmentId: department.id,
          title: input.title,
          brief: input.brief,
          phase: 'inbox',
          priority: input.priority,
          source: input.source,
          threadId: `task:${id}`,
          resourceId: `dept:${department.slug}`,
          dueAt: input.dueAt,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!task) throw new Error('Task insert returned no row');
      const events = await tx
        .insert(taskEvents)
        .values({
          taskId: id,
          type: 'created',
          actor,
          phase: task.phase,
          data: { title: task.title, source: task.source, priority: task.priority },
        })
        .returning();
      return { task, events };
    });
    for (const event of events) this.bus.publish(toEvent(event, task));
    return task;
  }

  async get(id: string): Promise<TaskRow> {
    const [task] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) throw new ApiError(404, 'task_not_found', `No task with id ${id}`);
    return task;
  }

  /** Accepts a task id, a number (42) or "#42". */
  async resolve(ref: string | number): Promise<TaskRow> {
    const text = String(ref).trim();
    const number = /^#?\d+$/.test(text) ? Number(text.replace('#', '')) : null;
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(number !== null ? eq(tasks.number, number) : eq(tasks.id, text));
    if (!task) throw new ApiError(404, 'task_not_found', `No task ${text}`);
    return task;
  }

  async getByThread(threadId: string): Promise<TaskRow | undefined> {
    const [task] = await this.db.select().from(tasks).where(eq(tasks.threadId, threadId));
    return task;
  }

  async list(filter: {
    departmentId?: string;
    phase?: TaskPhase;
    limit: number;
    before?: number;
  }): Promise<{ items: TaskRow[]; nextCursor: string | null }> {
    const items = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          filter.departmentId ? eq(tasks.departmentId, filter.departmentId) : undefined,
          filter.phase ? eq(tasks.phase, filter.phase) : undefined,
          filter.before ? lt(tasks.number, filter.before) : undefined,
        ),
      )
      .orderBy(desc(tasks.number))
      .limit(filter.limit);
    const last = items.at(-1);
    return { items, nextCursor: items.length === filter.limit && last ? String(last.number) : null };
  }

  /** Open tasks plus tasks closed in the last week, grouped by phase. */
  async board(departmentId?: string): Promise<Array<{ phase: TaskPhase; tasks: TaskRow[] }>> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          departmentId ? eq(tasks.departmentId, departmentId) : undefined,
          or(
            inArray(tasks.phase, [...OPEN_PHASES]),
            gte(tasks.closedAt, new Date(Date.now() - CLOSED_TASKS_ON_BOARD_MS)),
          ),
        ),
      )
      .orderBy(desc(tasks.updatedAt));
    return BOARD_PHASES.map((phase) => ({ phase, tasks: rows.filter((t) => t.phase === phase) }));
  }

  /** Moves a task to another phase if `actor` may make that move (staying put only where the matrix allows it). */
  transition(
    id: string,
    to: TaskPhase,
    actor: PhaseActor,
    actorLabel: string,
    extra: { patch?: Partial<typeof tasks.$inferInsert>; data?: Record<string, unknown> } = {},
  ): Promise<TaskRow> {
    return this.mutate(id, actorLabel, (task) => {
      if (!canTransition(actor, task.phase, to)) {
        throw new ApiError(
          409,
          'invalid_transition',
          `Task #${task.number} can't move from ${task.phase} to ${to}`,
        );
      }
      return {
        patch: { ...extra.patch, phase: to },
        events: [{ type: 'phase_changed', data: { from: task.phase, to, ...extra.data } }],
      };
    });
  }

  /**
   * Like transition, but only while `when` holds for the locked row; returns null (and changes nothing)
   * when it doesn't or the move isn't allowed. For background checks that may race with the owner.
   */
  async transitionIf(
    id: string,
    to: TaskPhase,
    actor: PhaseActor,
    actorLabel: string,
    when: (task: TaskRow) => boolean,
    data: Record<string, unknown> = {},
  ): Promise<TaskRow | null> {
    let applied = false;
    const task = await this.mutate(id, actorLabel, (current) => {
      if (!when(current) || !canTransition(actor, current.phase, to)) return null;
      applied = true;
      return {
        patch: { phase: to },
        events: [{ type: 'phase_changed', data: { from: current.phase, to, ...data } }],
      };
    });
    return applied ? task : null;
  }

  updateFields(
    id: string,
    fields: { title?: string; priority?: TaskPriority; dueAt?: Date | null },
    actorLabel: string,
  ): Promise<TaskRow> {
    return this.mutate(id, actorLabel, () => {
      const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(changed).length === 0) return null;
      return { patch: changed, events: [{ type: 'updated', data: { fields: Object.keys(changed) } }] };
    });
  }

  /** Progress from the lead: optional phase move, progress percentage, checklist and a note. */
  recordProgress(
    id: string,
    actorLabel: string,
    update: { phase?: 'working' | 'waiting'; progress?: number; checklist?: ChecklistItem[]; note?: string },
  ): Promise<TaskRow> {
    return this.mutate(id, actorLabel, (task) => {
      if (TERMINAL_PHASES.has(task.phase) || task.phase === 'review' || task.phase === 'inbox') {
        throw new ApiError(
          409,
          'task_not_active',
          `Task #${task.number} is ${task.phase}; it isn't being worked on`,
        );
      }
      const phase = update.phase ?? (task.phase === 'queued' ? 'working' : task.phase);
      if (phase !== task.phase && !canTransition('lead', task.phase, phase)) {
        throw new ApiError(
          409,
          'invalid_transition',
          `Task #${task.number} can't move from ${task.phase} to ${phase}`,
        );
      }
      return {
        patch: {
          phase,
          ...(update.progress !== undefined ? { progress: update.progress } : {}),
          ...(update.checklist !== undefined ? { checklist: update.checklist } : {}),
        },
        events: [
          { type: 'progress', data: { ...update, ...(phase !== task.phase ? { from: task.phase } : {}) } },
        ],
      };
    });
  }

  /** The lead's final report: moves to review, done, failed or waiting and stores the result. */
  report(
    id: string,
    actorLabel: string,
    report: {
      phase: 'review' | 'done' | 'failed' | 'waiting';
      outcome: string;
      summary: string;
      result: string;
    },
  ): Promise<TaskRow> {
    return this.mutate(id, actorLabel, (task) => {
      if (!canTransition('lead', task.phase, report.phase)) {
        throw new ApiError(
          409,
          'task_not_active',
          `Task #${task.number} is ${task.phase}; there's nothing to report`,
        );
      }
      return {
        patch: {
          phase: report.phase,
          result: report.result,
          ...(report.outcome === 'done' ? { progress: 100 } : {}),
        },
        events: [
          { type: 'reported', data: { outcome: report.outcome, summary: report.summary, from: task.phase } },
        ],
      };
    });
  }

  /** An event that doesn't change the task (dispatches, messages, notifications). */
  note(id: string, type: string, actorLabel: string, data: Record<string, unknown> = {}): Promise<TaskRow> {
    return this.mutate(id, actorLabel, () => ({ patch: {}, events: [{ type, data }] }), { bump: false });
  }

  async addArtifact(
    id: string,
    actorLabel: string,
    input: { kind: 'text' | 'link'; title: string; content?: string; url?: string },
  ): Promise<ArtifactRow> {
    const artifactId = uuidv7();
    let created: ArtifactRow | undefined;
    await this.mutate(
      id,
      actorLabel,
      () => ({
        patch: {},
        events: [{ type: 'artifact_added', data: { artifactId, title: input.title, kind: input.kind } }],
      }),
      {
        bump: true,
        inTx: async (tx) => {
          [created] = await tx
            .insert(artifacts)
            .values({
              id: artifactId,
              taskId: id,
              kind: input.kind,
              title: input.title,
              content: input.content,
              url: input.url,
            })
            .returning();
        },
      },
    );
    if (!created) throw new Error('Artifact insert returned no row');
    return created;
  }

  async events(taskId: string, options: { after?: number; limit: number }): Promise<TaskEvent[]> {
    const task = await this.get(taskId);
    const rows = await this.db
      .select()
      .from(taskEvents)
      .where(
        and(eq(taskEvents.taskId, taskId), options.after ? gt(taskEvents.seq, options.after) : undefined),
      )
      .orderBy(asc(taskEvents.seq))
      .limit(options.limit);
    return rows.map((row) => toEvent(row, task));
  }

  /** Events after `seq`, oldest first, for SSE replay. */
  async eventsSince(seq: number, filter: EventFilter, limit: number): Promise<TaskEvent[]> {
    const rows = await this.db
      .select({ event: taskEvents, task: { number: tasks.number, departmentId: tasks.departmentId } })
      .from(taskEvents)
      .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
      .where(
        and(
          gt(taskEvents.seq, seq),
          filter.taskId ? eq(taskEvents.taskId, filter.taskId) : undefined,
          filter.departmentId ? eq(tasks.departmentId, filter.departmentId) : undefined,
        ),
      )
      .orderBy(asc(taskEvents.seq))
      .limit(limit);
    return rows.map(({ event, task }) => toEvent(event, task));
  }

  async artifacts(taskId: string): Promise<ArtifactRow[]> {
    await this.get(taskId);
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(asc(artifacts.createdAt));
  }

  async openTasks(phases: TaskPhase[]): Promise<TaskRow[]> {
    return this.db.select().from(tasks).where(inArray(tasks.phase, phases));
  }

  private async mutate(
    id: string,
    actorLabel: string,
    change: (task: TaskRow) => Change,
    options: {
      bump?: boolean;
      inTx?: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<void>;
    } = {},
  ): Promise<TaskRow> {
    const { task, events } = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
      if (!current) throw new ApiError(404, 'task_not_found', `No task with id ${id}`);
      const result = change(current);
      if (!result) return { task: current, events: [] as TaskEventRow[] };

      const now = new Date();
      const nextPhase = (result.patch.phase ?? current.phase) as TaskPhase;
      const wasClosed = TERMINAL_PHASES.has(current.phase);
      const isClosed = TERMINAL_PHASES.has(nextPhase);
      const set = {
        ...result.patch,
        ...(options.bump === false ? {} : { revision: current.revision + 1, updatedAt: now }),
        ...(isClosed && !wasClosed ? { closedAt: now } : {}),
        ...(!isClosed && wasClosed ? { closedAt: null } : {}),
      };
      // Notes leave the row alone (the lock still orders them with other changes).
      let task = current;
      if (Object.keys(set).length > 0) {
        const [updated] = await tx.update(tasks).set(set).where(eq(tasks.id, id)).returning();
        if (!updated) throw new Error('Task update returned no row');
        task = updated;
      }
      await options.inTx?.(tx);
      const events = result.events.length
        ? await tx
            .insert(taskEvents)
            .values(
              result.events.map((e) => ({
                taskId: id,
                type: e.type,
                actor: actorLabel,
                phase: task.phase,
                data: e.data,
              })),
            )
            .returning()
        : [];
      return { task, events };
    });
    for (const event of events) this.bus.publish(toEvent(event, task));
    return task;
  }
}
