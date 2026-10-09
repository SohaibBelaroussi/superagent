import { type TaskEvent, TaskEventSchema } from '@superagent/shared';
import { apiUrl } from './http';
import { type LiveStatus, SseConnection, type SseConnectionOptions, type SseFrame, safeJson } from './sse';

export interface EventStreamHandlers {
  onEvent(event: TaskEvent): void;
  /**
   * Events may have been missed, so reload everything: the server skipped some (`reset`), or the
   * connection started from "now" (no Last-Event-ID), after the page had already loaded its data.
   */
  onReset(): void;
  onStatus(status: LiveStatus): void;
}

export interface EventStreamOptions {
  fetchImpl?: typeof fetch;
  watchOnline?: SseConnectionOptions['watchOnline'];
}

/**
 * The app's one connection to `GET /v1/events` (D46). It resumes from the last event it saw
 * (`Last-Event-ID`), so a reconnect replays what was missed.
 */
export class EventStream {
  private lastEventId: string | null = null;
  /** This connection sent a Last-Event-ID, so the server replays what it missed. */
  private resuming = false;
  private readonly connection: SseConnection;

  constructor(
    token: string,
    private readonly handlers: EventStreamHandlers,
    options: EventStreamOptions = {},
  ) {
    this.connection = new SseConnection({
      url: apiUrl('/v1/events'),
      token,
      fetchImpl: options.fetchImpl,
      watchOnline: options.watchOnline,
      headers: (): Record<string, string> => {
        this.resuming = this.lastEventId !== null;
        return this.lastEventId ? { 'last-event-id': this.lastEventId } : {};
      },
      onFrame: (frame) => this.handle(frame),
      onStatus: handlers.onStatus,
    });
  }

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.connection.stop();
  }

  /** The last event this stream saw, to resume from in a later stream (the phone's after a pause). */
  get position(): string | null {
    return this.lastEventId;
  }

  /** Resume from `id` (a stream this one replaces had got that far). */
  resumeFrom(id: string | null): void {
    this.lastEventId = id;
  }

  private handle(frame: SseFrame): void {
    if (frame.id) this.lastEventId = frame.id;
    if (frame.event === 'ready') {
      this.connection.live();
      // Started from "now", not from an event of ours: whatever changed between the page loading its data
      // and this moment never comes as an event, so look again once.
      if (!this.resuming) this.handlers.onReset();
      this.resuming = true;
    } else if (frame.event === 'reset') {
      this.handlers.onReset();
    } else if (frame.event === 'task' && frame.data) {
      const parsed = TaskEventSchema.safeParse(safeJson(frame.data));
      if (parsed.success) this.handlers.onEvent(parsed.data);
    }
  }
}
