import type { TaskEvent } from '@superagent/shared';
import type { QueryClient, QueryKey } from '@tanstack/query-core';
import { queryKeys } from './queries';

/**
 * What a task event makes stale: that task, the lists it appears in, and the attention inbox. A task a
 * schedule made also moves that schedule's last and next runs.
 */
export function staleKeysFor(event: TaskEvent): QueryKey[] {
  const keys: QueryKey[] = [
    queryKeys.task(event.taskId),
    queryKeys.board,
    queryKeys.tasks(),
    queryKeys.attention,
  ];
  if (event.type === 'created' && event.data.source === 'schedule') keys.push(queryKeys.schedules);
  return keys;
}

export interface LiveRefresh {
  /** A task event: refresh what it makes stale, batched. */
  event(event: TaskEvent): void;
  /** Events may have been missed: refresh everything. */
  reset(): void;
  stop(): void;
}

/**
 * Refreshes the queries live events make stale, batched so a burst of events costs one refetch per
 * query.
 */
export function createLiveRefresh(queryClient: QueryClient, delayMs = 200): LiveRefresh {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const key of pending.values()) void queryClient.invalidateQueries({ queryKey: key });
    pending.clear();
  };
  return {
    event(event) {
      for (const key of staleKeysFor(event)) pending.set(JSON.stringify(key), key);
      timer ??= setTimeout(flush, delayMs);
    },
    reset() {
      void queryClient.invalidateQueries();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
