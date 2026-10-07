import type { IMastraLogger } from '@mastra/core/logger';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import { type DecisionRow, decisions } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { Mutex } from '../../util/mutex';
import type { DispatchService } from '../dispatch/service';
import type { AttentionService } from './service';

/**
 * The owner's decisions on attention items (decision D32). Each is recorded; a retry with the same
 * idempotency key returns the first outcome instead of deciding twice.
 */
export class DecisionService {
  private readonly lock = new Mutex();

  constructor(
    private readonly db: Db,
    private readonly attention: AttentionService,
    private readonly dispatch: DispatchService,
    private readonly logger: IMastraLogger,
  ) {}

  decide(
    target: string,
    kind: 'approve' | 'decline',
    reason: string | undefined,
    idempotencyKey: string | undefined,
    actorLabel: string,
  ): Promise<DecisionRow> {
    return this.lock.run(async () => {
      if (idempotencyKey) {
        const [existing] = await this.db
          .select()
          .from(decisions)
          .where(eq(decisions.idempotencyKey, idempotencyKey));
        if (existing) {
          if (existing.target !== target || existing.kind !== kind) {
            throw new ApiError(
              409,
              'idempotency_key_reused',
              'This Idempotency-Key was used for another decision',
            );
          }
          return existing;
        }
      }
      const [decided] = await this.db
        .select()
        .from(decisions)
        .where(and(eq(decisions.target, target), eq(decisions.status, 'applied')))
        .limit(1);
      if (decided) {
        throw new ApiError(
          409,
          'already_decided',
          `This tool call was already ${decided.kind === 'approve' ? 'approved' : 'declined'}`,
        );
      }
      const approval = await this.attention.findApproval(target);
      if (!approval) {
        throw new ApiError(
          404,
          'attention_item_not_found',
          'Nothing waits for a decision under this id (it may be decided already)',
        );
      }
      let status: DecisionRow['status'] = 'applied';
      let taskId: string | null = null;
      let error: string | null = null;
      try {
        taskId = (await this.dispatch.resolveApproval(approval, kind, reason, actorLabel))?.id ?? null;
      } catch (cause) {
        status = 'failed';
        error = cause instanceof Error ? cause.message : String(cause);
        this.logger.error('Applying a decision failed', { target, kind, error: cause });
      }
      const [row] = await this.db
        .insert(decisions)
        .values({
          id: uuidv7(),
          idempotencyKey: idempotencyKey ?? uuidv7(),
          kind,
          target,
          reason: reason ?? null,
          status,
          taskId,
          error,
        })
        .returning();
      if (!row) throw new Error('Decision insert returned no row');
      return row;
    });
  }
}
