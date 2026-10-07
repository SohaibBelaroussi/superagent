import type { IMastraLogger } from '@mastra/core/logger';
import type { PruneOptions, PruneResult } from '@mastra/core/storage';

/** The first prune waits this long after boot: pruning is maintenance, never part of startup. */
const FIRST_RUN_MS = 10 * 60_000;

/**
 * Deletes traces older than the configured retention (decision D39): Mastra declares retention on the
 * store but never prunes on its own. Bounded runs, every few hours; a run in progress stops on close.
 */
export class TracePruner {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly stopped = new AbortController();

  constructor(
    private readonly storage: { prune(options?: PruneOptions): Promise<PruneResult[]> },
    private readonly logger: IMastraLogger,
    private readonly everyMs = 6 * 60 * 60_000,
  ) {}

  start(): void {
    const first = setTimeout(() => {
      void this.run();
      this.timer = setInterval(() => void this.run(), this.everyMs);
      this.timer.unref();
    }, FIRST_RUN_MS);
    first.unref();
    this.timer = first;
  }

  /** One bounded pass; a pass already under way is joined. */
  run(): Promise<void> {
    this.running ??= this.storage
      .prune({ signal: this.stopped.signal, maxBatches: 200, pauseMs: 20 })
      .then((results) => {
        const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
        if (deleted > 0) this.logger.info('Old traces pruned', { deleted });
      })
      .catch((error: unknown) => this.logger.warn('Pruning old traces failed', { error: String(error) }))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.stopped.abort();
    await this.running;
  }
}
