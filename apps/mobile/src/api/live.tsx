import { createLiveRefresh, EventStream, type LiveStatus } from '@superagent/client';
import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

const LiveStatusContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

/** Wakes a waiting reconnect when the phone's network comes back. */
function watchNetwork(wake: () => void): () => void {
  const subscription = Network.addNetworkStateListener((network) => {
    if (network.isConnected) wake();
  });
  return () => subscription.remove();
}

/**
 * The live events (D55): one `/v1/events` connection while the app is in the foreground. The system
 * stops background connections anyway, so it closes when the app leaves, and resumes from the last
 * event it saw when the app comes back, so nothing in between is missed. Push covers the time away.
 * Signed out (no token), there is no connection.
 */
export function LiveEventsProvider({ token, children }: { token: string | null; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (!token) return;
    const refresh = createLiveRefresh(queryClient);
    let stream: EventStream | null = null;
    let position: string | null = null;

    const open = () => {
      if (stream) return;
      setStatus('connecting');
      stream = new EventStream(
        token,
        { onEvent: refresh.event, onReset: refresh.reset, onStatus: setStatus },
        { watchOnline: watchNetwork },
      );
      stream.resumeFrom(position);
      stream.start();
    };
    const close = () => {
      if (!stream) return;
      position = stream.position;
      stream.stop();
      stream = null;
    };
    // Only the background closes it: the state starts 'unknown' on some phones, and iOS says
    // 'inactive' while its app switcher or a system sheet is over the app.
    const follow = (state: AppStateStatus | null | undefined) => (state === 'background' ? close() : open());

    follow(AppState.currentState);
    const subscription = AppState.addEventListener('change', follow);
    return () => {
      subscription.remove();
      close();
      refresh.stop();
    };
  }, [token, queryClient]);

  return <LiveStatusContext value={status}>{children}</LiveStatusContext>;
}
