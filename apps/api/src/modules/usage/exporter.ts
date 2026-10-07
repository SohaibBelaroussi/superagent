import { type TracingEvent, TracingEventType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import { callFromSpan, type UsageService } from './service';

/**
 * Turns every model request Mastra traces into a usage row (decision D40), as its span ends: one per
 * MODEL_INFERENCE span (the generation and step spans above it repeat the same tokens), so a lead's,
 * its specialists' and memory's requests are all counted once, each at its own model's price.
 */
export class UsageExporter extends BaseExporter {
  name = 'superagent-usage';

  constructor(private readonly usage: UsageService) {
    super();
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== TracingEventType.SPAN_ENDED) return;
    const call = callFromSpan(event.exportedSpan);
    if (call) this.usage.record(call);
  }

  override async flush(): Promise<void> {
    await this.usage.flush();
  }

  override async shutdown(): Promise<void> {
    await this.usage.flush();
  }
}
