import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import { type DecisionRow, decisions } from '../../db/schema';
import { Mutex } from '../../util/mutex';

/**
 * Decisions on tool calls waiting for approval (decision D32), the owner's and the ones a cancel makes.
 * Each is written before Mastra hears of it and removed if Mastra refuses it, so a call is never
 * resumed twice and a resumed one is never offered again, even after a restart.
 */
export class DecisionLog {
  /**
   * Held while a call is decided, and while new work for a task checks that nothing waits on it, so a
   * decision and a fresh run never both start on one thread.
   */
  readonly lock = new Mutex();

  constructor(private readonly db: Db) {}

  async byKey(idempotencyKey: string): Promise<DecisionRow | undefined> {
    const [row] = await this.db.select().from(decisions).where(eq(decisions.idempotencyKey, idempotencyKey));
    return row;
  }

  /** The decision made (or being applied) on a call, if any. */
  async of(target: string): Promise<DecisionRow | undefined> {
    const [row] = await this.db.select().from(decisions).where(eq(decisions.target, target)).limit(1);
    return row;
  }

  /** The calls among these that were decided. */
  async decided(targets: string[]): Promise<Set<string>> {
    if (targets.length === 0) return new Set();
    const rows = await this.db
      .select({ target: decisions.target })
      .from(decisions)
      .where(inArray(decisions.target, targets));
    return new Set(rows.map((row) => row.target));
  }

  /** Records a decision about to be applied. */
  async begin(decision: {
    target: string;
    kind: 'approve' | 'decline';
    reason?: string;
    idempotencyKey?: string;
    taskId?: string | null;
  }): Promise<DecisionRow> {
    const [row] = await this.db
      .insert(decisions)
      .values({
        id: uuidv7(),
        idempotencyKey: decision.idempotencyKey ?? uuidv7(),
        kind: decision.kind,
        target: decision.target,
        reason: decision.reason ?? null,
        status: 'pending',
        taskId: decision.taskId ?? null,
      })
      .returning();
    if (!row) throw new Error('Decision insert returned no row');
    return row;
  }

  /** Mastra took the decision: the run carries on. */
  async applied(id: string, taskId: string | null): Promise<DecisionRow> {
    const [row] = await this.db
      .update(decisions)
      .set({ status: 'applied', taskId })
      .where(and(eq(decisions.id, id), eq(decisions.status, 'pending')))
      .returning();
    if (!row) throw new Error(`Decision ${id} is not pending`);
    return row;
  }

  /** Mastra refused the decision, so nothing happened: the call can be decided again. */
  async abandon(id: string): Promise<void> {
    await this.db.delete(decisions).where(eq(decisions.id, id));
  }
}
