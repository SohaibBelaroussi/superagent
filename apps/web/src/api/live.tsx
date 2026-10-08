import type { TaskEvent } from '@superagent/shared';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { EventStream, type LiveStatus } from './events';
import { queryKeys } from './queries';

const LiveStatusContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

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

/**
 * Keeps the app's data current while signed in: one event stream (D46), whose events refresh the
 * queries they affect, batched so a burst of events costs one refetch per query.
 */
export function LiveEventsProvider({ token, children }: { token: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    const pending = new Map<string, QueryKey>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      for (const key of pending.values()) void queryClient.invalidateQueries({ queryKey: key });
      pending.clear();
    };
    const stream = new EventStream(token, {
      onEvent: (event) => {
        for (const key of staleKeysFor(event)) pending.set(JSON.stringify(key), key);
        timer ??= setTimeout(flush, 200);
      },
      onReset: () => void queryClient.invalidateQueries(),
      onStatus: setStatus,
    });
    stream.start();
    return () => {
      stream.stop();
      clearTimeout(timer);
    };
  }, [token, queryClient]);

  return <LiveStatusContext value={status}>{children}</LiveStatusContext>;
}
