import type { IMastraLogger } from '@mastra/core/logger';
import { computeNextFireAt, validateCron } from '@mastra/core/workflows';
import type { CreateScheduleInput, UpdateScheduleInput } from '@superagent/shared';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import { type ScheduleRow, schedules, type TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { isValidTimezone } from '../../util/text';
import type { DispatchService } from '../dispatch/service';
import type { TaskService } from '../ledger/service';
import type { OrgDirectory } from '../org/directory';
import type { SettingsService } from '../settings/service';

/** Schedules may not fire more often than this: each fire is a task for a lead. */
export const MIN_INTERVAL_MS = 5 * 60_000;
const DUE_BATCH = 50;
const MAX_MISSED_COUNT = 1000;

export interface ScheduleDeps {
  db: Db;
  directory: OrgDirectory;
  tasks: TaskService;
  dispatch: DispatchService;
  settings: SettingsService;
  logger: IMastraLogger;
  tickMs: number;
}

/**
 * Recurring tasks (decision D31). Each fire creates a task for the department and sends it to the
 * department's current lead. Our own ticker claims due rows with a compare-and-set on next_fire_at,
 * so a fire happens once; the first tick after boot catches up on fires missed while the server was
 * down (once per schedule, noting how many were skipped).
 */
export class ScheduleService {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly deps: ScheduleDeps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.ticking;
  }

  /** Fires every schedule that is due. Ticks never overlap. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.ticking) {
      this.ticking = this.fireDue()
        .catch((error: unknown) => this.deps.logger.error('Schedule tick failed', { error }))
        .finally(() => {
          this.ticking = undefined;
        });
    }
    return this.ticking;
  }

  async list(filter: { departmentId?: string } = {}): Promise<ScheduleRow[]> {
    return this.deps.db
      .select()
      .from(schedules)
      .where(filter.departmentId ? eq(schedules.departmentId, filter.departmentId) : undefined)
      .orderBy(desc(schedules.createdAt));
  }

  async get(id: string): Promise<ScheduleRow> {
    const [row] = await this.deps.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) throw new ApiError(404, 'schedule_not_found', `No schedule with id ${id}`);
    return row;
  }

  async create(input: CreateScheduleInput, actor: string): Promise<ScheduleRow> {
    this.activeDepartment(input.departmentId);
    const timezone = input.timezone ?? this.deps.settings.get().timezone;
    const nextFireAt = this.firstFire(input.cron, timezone);
    const now = new Date();
    const [row] = await this.deps.db
      .insert(schedules)
      .values({
        id: uuidv7(),
        departmentId: input.departmentId,
        title: input.title,
        brief: input.brief,
        priority: input.priority,
        cron: input.cron,
        timezone,
        status: 'active',
        nextFireAt,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('Schedule insert returned no row');
    this.deps.logger.info('Schedule created', { scheduleId: row.id, cron: row.cron, timezone, actor });
    return row;
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<ScheduleRow> {
    const current = await this.get(id);
    const cron = patch.cron ?? current.cron;
    const timezone = patch.timezone ?? current.timezone;
    const status = patch.status ?? current.status;
    const timingChanged = cron !== current.cron || timezone !== current.timezone || status !== current.status;
    // Validate even when paused, so a bad cron never sits waiting for a resume.
    const nextFireAt =
      timingChanged || patch.cron || patch.timezone ? this.firstFire(cron, timezone) : current.nextFireAt;
    if (status === 'active') this.activeDepartment(current.departmentId);
    const [row] = await this.deps.db
      .update(schedules)
      .set({
        title: patch.title ?? current.title,
        brief: patch.brief ?? current.brief,
        priority: patch.priority ?? current.priority,
        cron,
        timezone,
        status,
        nextFireAt: status === 'active' ? nextFireAt : null,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, id))
      .returning();
    if (!row) throw new ApiError(404, 'schedule_not_found', `No schedule with id ${id}`);
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.deps.db.delete(schedules).where(eq(schedules.id, id));
  }

  /** Fires a schedule now: the same task a scheduled fire would create. */
  async runNow(id: string, actor: string): Promise<TaskRow> {
    const row = await this.get(id);
    return this.fire(row, `schedule:${id}:manual:${Date.now()}`, 0, actor);
  }

  /** When a cron next fires after `after`, as a Date. Throws a 400 for a bad cron or timezone. */
  nextFire(cron: string, timezone: string, after: Date = new Date()): Date {
    if (!isValidTimezone(timezone)) {
      throw new ApiError(400, 'invalid_timezone', `"${timezone}" is not an IANA timezone`);
    }
    try {
      validateCron(cron, timezone);
      return new Date(computeNextFireAt(cron, { timezone, after: after.getTime() }));
    } catch (error) {
      throw new ApiError(400, 'invalid_cron', error instanceof Error ? error.message : String(error));
    }
  }

  private firstFire(cron: string, timezone: string): Date {
    const first = this.nextFire(cron, timezone);
    const second = this.nextFire(cron, timezone, first);
    if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
      throw new ApiError(400, 'schedule_too_frequent', 'Schedules can fire at most every 5 minutes');
    }
    return first;
  }

  private async fireDue(): Promise<void> {
    const due = await this.deps.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.status, 'active'), lte(schedules.nextFireAt, new Date())))
      .orderBy(asc(schedules.nextFireAt))
      .limit(DUE_BATCH);
    for (const row of due) {
      if (this.stopped) return;
      await this.claimAndFire(row).catch((error: unknown) =>
        this.deps.logger.error('A schedule could not fire', { scheduleId: row.id, error }),
      );
    }
  }

  private async claimAndFire(row: ScheduleRow): Promise<void> {
    const dueAt = row.nextFireAt;
    if (!dueAt) return;
    const now = new Date();
    let next: Date | null;
    try {
      next = this.nextFire(row.cron, row.timezone, now);
    } catch (error) {
      // A cron that stopped being valid (it was validated on save) pauses rather than firing forever.
      this.deps.logger.error('Pausing a schedule whose cron no longer works', { scheduleId: row.id, error });
      next = null;
    }
    const [claimed] = await this.deps.db
      .update(schedules)
      .set({
        nextFireAt: next,
        lastFireAt: now,
        updatedAt: now,
        ...(next ? {} : { status: 'paused' as const }),
      })
      .where(and(eq(schedules.id, row.id), eq(schedules.status, 'active'), eq(schedules.nextFireAt, dueAt)))
      .returning();
    if (!claimed) return; // fired by an overlapping claim, edited or paused meanwhile
    const missed = this.missedBetween(row.cron, row.timezone, dueAt, now);
    await this.fire(claimed, `schedule:${row.id}:${dueAt.toISOString()}`, missed, 'schedule');
  }

  /** Occurrences after `dueAt` up to `now`: fires skipped while the server was down. */
  private missedBetween(cron: string, timezone: string, dueAt: Date, now: Date): number {
    let missed = 0;
    let at = dueAt;
    while (missed < MAX_MISSED_COUNT) {
      at = new Date(computeNextFireAt(cron, { timezone, after: at.getTime() }));
      if (at > now) break;
      missed += 1;
    }
    return missed;
  }

  private async fire(
    row: ScheduleRow,
    idempotencyKey: string,
    missed: number,
    actor: string,
  ): Promise<TaskRow> {
    const department = this.deps.directory.department(row.departmentId);
    if (!department || department.archivedAt) {
      await this.deps.db
        .update(schedules)
        .set({ status: 'paused', nextFireAt: null, updatedAt: new Date() })
        .where(eq(schedules.id, row.id));
      throw new ApiError(409, 'department_archived', 'The schedule was paused: its department is archived');
    }
    const note =
      missed > 0
        ? `\n\n(The server was down: ${missed} earlier run${missed === 1 ? ' was' : 's were'} skipped.)`
        : '';
    const task = await this.deps.tasks.create(
      {
        departmentId: row.departmentId,
        title: row.title,
        brief: `${row.brief}${note}`,
        priority: row.priority,
        source: 'schedule',
        scheduleId: row.id,
        idempotencyKey,
      },
      actor,
    );
    await this.deps.db.update(schedules).set({ lastTaskId: task.id }).where(eq(schedules.id, row.id));
    if (task.phase !== 'inbox') return task; // the same fire again: already sent
    if (this.deps.directory.leadOf(row.departmentId))
      return this.deps.dispatch.dispatch(task, 'system', 'schedule');
    await this.deps.tasks.note(task.id, 'not_dispatched', 'system', { reason: 'The department has no lead' });
    return task;
  }

  private activeDepartment(id: string) {
    const department = this.deps.directory.department(id);
    if (!department) throw new ApiError(404, 'department_not_found', `No department with id ${id}`);
    if (department.archivedAt) throw new ApiError(409, 'department_archived', 'This department is archived');
    return department;
  }
}
