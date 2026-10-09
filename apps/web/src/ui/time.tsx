import { formatDateTime, formatRelative } from '@superagent/client';
import { useSyncExternalStore } from 'react';

/*
 * One clock for every relative time on screen: it ticks every 30 seconds while something listens, so
 * "5m ago" stays true without each row keeping its own timer.
 */
const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    tick += 1;
    for (const notify of listeners) notify();
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Re-renders the caller every 30 seconds. */
export function useClock(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => tick,
  );
}

/** "5m ago", with the full date and time on hover. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  useClock();
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  );
}
