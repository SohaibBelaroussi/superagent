import type { Context } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { currentUser } from './auth';
import type { AppDeps, AppEnv } from './types';

/** A comment this often keeps proxies, and the client's silence watchdog, from dropping a quiet stream. */
const HEARTBEAT_MS = 25_000;

/**
 * A long-lived Server-Sent Events response. It ends when the client goes away or when the token that
 * opened it is revoked (decision D45): `signal` aborts, `run` should then return, and the stream closes.
 */
export function liveStream(
  c: Context<AppEnv>,
  deps: Pick<AppDeps, 'tokens'>,
  run: (stream: SSEStreamingApi, signal: AbortSignal) => Promise<void>,
): Response {
  const tokenId = currentUser(c).tokenId;
  return streamSSE(c, async (stream) => {
    const ended = new AbortController();
    stream.onAbort(() => ended.abort());
    const stopWatching = deps.tokens.onRevoked((id) => {
      if (id === tokenId) ended.abort();
    });
    const heartbeat = setInterval(() => void stream.write(': keep-alive\n\n'), HEARTBEAT_MS);
    try {
      await run(stream, ended.signal);
    } finally {
      clearInterval(heartbeat);
      stopWatching();
    }
  });
}

/** The API docs' description of a conversation's live stream (the chief's, a task's). */
export const LIVE_EVENTS_DESCRIPTION =
  'Sends `ready` ({ running }) once subscribed, then each turn as it happens: `run-start`, `text` and `reasoning` ' +
  'deltas (a new block id starts a new block), `tool` (a call as it stands, replacing the one with the same ' +
  'callId), `message` (something that reached the agent, such as a report) and `run-end` ({ outcome, error }). ' +
  "Each event's data is JSON with its type (LiveEvent). Once a turn has ended it is in the history; after a " +
  'reconnect, reload the history. Heartbeat comments every 25 s.';

/** Resolves once `signal` has aborted. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
