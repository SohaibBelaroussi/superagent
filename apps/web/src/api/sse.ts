import { notifyUnauthorized } from './client';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
}

export interface SseConnectionOptions {
  path: string;
  token: string;
  /** Headers for the next connection attempt, such as the Last-Event-ID to resume from. */
  headers?: () => Record<string, string>;
  onFrame(frame: SseFrame): void;
  onStatus(status: LiveStatus): void;
  fetchImpl?: typeof fetch;
}

/** The server sends a comment every 25 s; this much silence means the connection is gone. */
const SILENCE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One long-lived Server-Sent Events connection, read with fetch so the token travels in a header, not
 * in the URL. A drop, or a minute without a byte, reconnects it after a backoff with jitter; coming back
 * online skips the wait. Its owner calls `live()` once the stream says it is caught up.
 */
export class SseConnection {
  private controller: AbortController | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private wake: (() => void) | null = null;
  private status: LiveStatus = 'connecting';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SseConnectionOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  start(): void {
    // A connection that hears nothing for a minute (not even a heartbeat, or no answer at all to the
    // request) is gone, whatever the socket thinks: abort it and reconnect.
    this.watchdog = setInterval(() => {
      if (this.controller && Date.now() - this.lastHeard > SILENCE_MS) this.controller.abort();
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

  /** The stream is caught up: say so, and let the next drop start its backoff from the beginning. */
  live(): void {
    this.backoffMs = 1000;
    this.setStatus('live');
  }

  /** Back online: skip the rest of the backoff. */
  private reconnectNow = () => {
    this.backoffMs = 1000;
    this.wake?.();
  };

  private setStatus(status: LiveStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const headers: Record<string, string> = {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.options.token}`,
          ...this.options.headers?.(),
        };
        this.lastHeard = Date.now();
        const response = await this.fetchImpl(this.options.path, {
          headers,
          signal: this.controller.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        if (response.status === 401) {
          notifyUnauthorized(this.options.token);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`The stream answered ${response.status}`);
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
          if (frame && !this.stopped) this.options.onFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** One SSE frame; comments (heartbeats) give null. */
export function parseFrame(raw: string): SseFrame | null {
  const frame: SseFrame = {};
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

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
