import { randomUUID } from 'node:crypto';
import type { BrowserIdentity, CreateBrowserIdentityInput } from '@superagent/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { isUniqueViolation } from '../../db/errors';
import { type BrowserIdentityRow, browserIdentities, type TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { TaskService } from '../ledger/service';
import type { RunnerClient } from '../workspace/runner-client';
import { RunnerRequestError } from '../workspace/runner-client';

/** How long a lock lasts without renewal: its holder renews it while its browser is open. */
export const LEASE_MS = 2 * 60_000;

/** Who holds an identity: a task's browser, or the owner's sign-in session. */
export type IdentityHolder = { kind: 'task'; taskId: string } | { kind: 'owner' };

/**
 * Browser identities (decision D34): named, signed-in browser profiles. The runner keeps each profile
 * in a volume; this keeps the names and the lock that lets one browser at a time use a profile.
 */
export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly runner: RunnerClient | undefined,
    /** The agents whose browser grant uses an identity, by its name (deleting it is refused then). */
    private readonly grantedTo: (name: string) => string[],
  ) {}

  async list(): Promise<BrowserIdentity[]> {
    const rows = await this.db.select().from(browserIdentities).orderBy(browserIdentities.name);
    return this.present(rows);
  }

  async get(id: string): Promise<BrowserIdentity> {
    const [view] = await this.present([await this.row(id)]);
    return view as BrowserIdentity;
  }

  async row(id: string): Promise<BrowserIdentityRow> {
    const [row] = await this.db.select().from(browserIdentities).where(eq(browserIdentities.id, id));
    if (!row) throw new ApiError(404, 'identity_not_found', 'No browser identity with this id');
    return row;
  }

  async byName(name: string): Promise<BrowserIdentityRow | undefined> {
    const [row] = await this.db.select().from(browserIdentities).where(eq(browserIdentities.name, name));
    return row;
  }

  async create(input: CreateBrowserIdentityInput): Promise<BrowserIdentity> {
    try {
      const [row] = await this.db
        .insert(browserIdentities)
        .values({ id: randomUUID(), name: input.name, description: input.description ?? '' })
        .returning();
      return this.get((row as BrowserIdentityRow).id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, 'identity_exists', `A browser identity named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  /**
   * Deletes an identity and its profile (its cookies and saved sign-ins). Refused while a browser uses
   * it or an agent's browser grant names it.
   */
  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    const agents = this.grantedTo(row.name);
    if (agents.length > 0) {
      throw new ApiError(
        409,
        'identity_granted',
        `Agents use this identity (${agents.join(', ')}): change their browser grant first`,
      );
    }
    if (this.isLocked(row)) {
      throw new ApiError(409, 'identity_in_use', 'A browser is using this identity: close it first');
    }
    if (this.runner) {
      try {
        await this.runner.removeIdentity(id);
      } catch (error) {
        if (error instanceof RunnerRequestError && error.code === 'identity_in_use') {
          throw new ApiError(409, 'identity_in_use', 'A browser is using this identity: close it first');
        }
        throw error;
      }
    }
    await this.db.delete(browserIdentities).where(eq(browserIdentities.id, id));
  }

  /**
   * Takes the identity's lock for a holder, if it is free, lapsed, or already this holder's.
   * Returns false while someone else holds it. Throws if the identity is gone.
   */
  async acquire(id: string, holder: IdentityHolder): Promise<boolean> {
    const taskId = holder.kind === 'task' ? holder.taskId : null;
    const rows = await this.db
      .update(browserIdentities)
      .set({
        lockedBy: holder.kind,
        lockedByTask: taskId,
        lockedUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
        lastUsedAt: sql`now()`,
      })
      .where(
        and(
          eq(browserIdentities.id, id),
          sql`(${browserIdentities.lockedUntil} is null or ${browserIdentities.lockedUntil} < now()
            or (${browserIdentities.lockedBy} = ${holder.kind}
              and ${browserIdentities.lockedByTask} is not distinct from ${taskId}::uuid))`,
        ),
      )
      .returning({ id: browserIdentities.id });
    if (rows.length > 0) return true;
    await this.row(id);
    return false;
  }

  /** Extends the holder's lock. False if it no longer holds it (it lapsed and someone took it). */
  async renew(id: string, holder: IdentityHolder): Promise<boolean> {
    const rows = await this.db
      .update(browserIdentities)
      .set({ lockedUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`, lastUsedAt: sql`now()` })
      .where(and(eq(browserIdentities.id, id), this.heldBy(holder)))
      .returning({ id: browserIdentities.id });
    return rows.length > 0;
  }

  async release(id: string, holder: IdentityHolder): Promise<void> {
    await this.db
      .update(browserIdentities)
      .set({ lockedBy: null, lockedByTask: null, lockedUntil: null })
      .where(and(eq(browserIdentities.id, id), this.heldBy(holder)));
  }

  /** At startup: no browser of a previous run is still in use (one API process, decision D23). */
  async releaseAll(): Promise<void> {
    await this.db
      .update(browserIdentities)
      .set({ lockedBy: null, lockedByTask: null, lockedUntil: null })
      .where(isNotNull(browserIdentities.lockedBy));
  }

  private heldBy(holder: IdentityHolder) {
    const taskId = holder.kind === 'task' ? holder.taskId : null;
    return sql`${browserIdentities.lockedBy} = ${holder.kind}
      and ${browserIdentities.lockedByTask} is not distinct from ${taskId}::uuid
      and ${browserIdentities.lockedUntil} >= now()`;
  }

  private isLocked(row: BrowserIdentityRow): boolean {
    return Boolean(row.lockedBy && row.lockedUntil && row.lockedUntil.getTime() >= Date.now());
  }

  private async present(rows: BrowserIdentityRow[]): Promise<BrowserIdentity[]> {
    const taskIds = rows.flatMap((row) => (this.isLocked(row) && row.lockedByTask ? [row.lockedByTask] : []));
    const tasks = taskIds.length > 0 ? await this.tasks.byIds(taskIds) : new Map<string, TaskRow>();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      holder:
        this.isLocked(row) && row.lockedBy && row.lockedUntil
          ? {
              kind: row.lockedBy,
              taskId: row.lockedByTask,
              taskNumber: row.lockedByTask ? (tasks.get(row.lockedByTask)?.number ?? null) : null,
              until: row.lockedUntil.toISOString(),
            }
          : null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
