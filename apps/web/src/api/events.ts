import { type TaskEvent, TaskEventSchema } from '@superagent/shared';
import { notifyUnauthorized } from './client';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface EventStreamHandlers {
  onEvent(event: TaskEvent): void;
  /** The server skipped events (too many missed): reload everything. */
  onReset(): void;
  onStatus(status: LiveStatus): void;
}

interface Frame {
  event?: string;
  id?: string;
  data?: string;
}

/** The server sends a comment every 25 s; this much silence means the connection is gone. */
const SILENCE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * The app's one connection to `GET /v1/events` (D46). Read with fetch, so the token travels in a header.
 * It resumes from the last event it saw (`Last-Event-ID`), so a reconnect replays what was missed.
 */
export class EventStream {
  private lastEventId: string | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private wake: (() => void) | null = null;
  private status: LiveStatus = 'connecting';

  constructor(
    private readonly token: string,
    private readonly handlers: EventStreamHandlers,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  start(): void {
    this.watchdog = setInterval(() => {
      if (this.controller && this.lastHeard && Date.now() - this.lastHeard > SILENCE_MS)
        this.controller.abort();
    }, 15_000);
    window.addEventListener('online', this.reconnectNow);
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog);
    window.removeEventListener('online', this.reconnectNow);
    this.controller?.abort();
    this.wake?.();
  }

  /** Back online: skip the rest of the backoff. */
  private reconnectNow = () => {
    this.backoffMs = 1000;
    this.wake?.();
  };

  private setStatus(status: LiveStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const headers: Record<string, string> = {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.token}`,
        };
        if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
        const response = await this.fetchImpl('/v1/events', {
          headers,
          signal: this.controller.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        if (response.status === 401) {
          notifyUnauthorized();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Event stream answered ${response.status}`);
        this.lastHeard = Date.now();
        await this.read(response.body);
      } catch {
        // Dropped, refused or aborted by the watchdog: reconnect below.
      }
      if (this.stopped) return;
      this.setStatus('offline');
      await this.sleep(this.backoffMs * (0.75 + Math.random() * 0.5));
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => done(), ms);
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      this.wake = done;
    });
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        this.lastHeard = Date.now();
        // Normalized on the whole buffer, so a CRLF split across two chunks still reads as one break.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame = parseFrame(raw);
          if (frame) this.handle(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handle(frame: Frame): void {
    if (frame.id) this.lastEventId = frame.id;
    if (frame.event === 'ready') {
      this.backoffMs = 1000;
      this.setStatus('live');
    } else if (frame.event === 'reset') {
      this.handlers.onReset();
    } else if (frame.event === 'task' && frame.data) {
      const parsed = TaskEventSchema.safeParse(safeJson(frame.data));
      if (parsed.success) this.handlers.onEvent(parsed.data);
    }
  }
}

/** One SSE frame; comments (heartbeats) give null. */
export function parseFrame(raw: string): Frame | null {
  const frame: Frame = {};
  let fields = 0;
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event' || field === 'id') frame[field] = value;
    else if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
    else continue;
    fields += 1;
  }
  return fields > 0 ? frame : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
