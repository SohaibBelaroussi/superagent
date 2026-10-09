import { createLiveRefresh, EventStream, type LiveStatus } from '@superagent/client';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

const LiveStatusContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

/**
 * Keeps the app's data current while signed in: one event stream (D46), whose events refresh the
 * queries they affect, batched so a burst of events costs one refetch per query.
 */
export function LiveEventsProvider({ token, children }: { token: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    const refresh = createLiveRefresh(queryClient);
    const stream = new EventStream(token, {
      onEvent: refresh.event,
      onReset: refresh.reset,
      onStatus: setStatus,
    });
    stream.start();
    return () => {
      stream.stop();
      refresh.stop();
    };
  }, [token, queryClient]);

  return <LiveStatusContext value={status}>{children}</LiveStatusContext>;
}
