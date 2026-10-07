import type { IMastraLogger } from '@mastra/core/logger';
import type { DecisionRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { DecisionLog } from '../dispatch/decisions';
import type { DispatchService } from '../dispatch/service';
import type { AttentionService } from './service';

/**
 * The owner's decisions on attention items (decision D32). Each is recorded before it is applied; a
 * retry with the same idempotency key returns the first outcome instead of deciding twice.
 */
export class DecisionService {
  constructor(
    private readonly log: DecisionLog,
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
    return this.log.lock.run(async () => {
      if (idempotencyKey !== undefined) {
        const existing = await this.log.byKey(idempotencyKey);
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
      const earlier = await this.log.of(target);
      if (earlier) {
        throw new ApiError(
          409,
          'already_decided',
          `This tool call was already ${earlier.kind === 'approve' ? 'approved' : 'declined'}`,
        );
      }
      const approval = await this.attention.findApproval(target);
      if (!approval) {
        throw new ApiError(404, 'attention_item_not_found', 'Nothing waits for a decision under this id');
      }
      const row = await this.log.begin({
        target,
        kind,
        reason,
        idempotencyKey,
        taskId: approval.task?.id ?? null,
      });
      let taskId: string | null;
      try {
        taskId = (await this.dispatch.resolveApproval(approval, kind, reason, actorLabel))?.id ?? null;
      } catch (cause) {
        // Mastra refused it, so nothing ran: forget it, and the call can be decided again.
        await this.log.abandon(row.id);
        this.logger.error('Applying a decision failed', { target, kind, error: cause });
        throw new ApiError(
          500,
          'decision_failed',
          `The decision could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      return this.log.applied(row.id, taskId);
    });
  }
}
