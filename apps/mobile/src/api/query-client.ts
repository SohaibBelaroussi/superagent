import { errorMessage, ProblemError } from '@superagent/client';
import { focusManager, MutationCache, onlineManager, QueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { AppState, Platform } from 'react-native';
import { toast } from '../ui/toast';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** What the toast says when the mutation fails ("Couldn't cancel the task"). */
      failure?: string;
      /** The mutation shows its own error: no toast. */
      silent?: boolean;
    };
  }
}

/** Client errors (4xx) won't change on a retry; network errors and 5xx get two more tries. */
function shouldRetry(failures: number, error: unknown): boolean {
  if (error instanceof ProblemError && error.status >= 400 && error.status < 500) return false;
  return failures < 2;
}

let wired = false;

/**
 * The app being in the foreground counts as focus (queries refresh when you come back to it), and the
 * phone's network as online status (requests wait for it rather than failing).
 */
function wireNativeEvents(): void {
  if (wired || Platform.OS === 'web') return;
  wired = true;
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener('change', (status) => setFocused(status === 'active'));
    return () => subscription.remove();
  });
  onlineManager.setEventListener((setOnline) => {
    const subscription = Network.addNetworkStateListener((network) =>
      setOnline(network.isConnected !== false),
    );
    return () => subscription.remove();
  });
}

export function createQueryClient(): QueryClient {
  wireNativeEvents();
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Live events refresh what changes in the foreground; this bounds how stale a screen can be.
        staleTime: 30_000,
        retry: shouldRetry,
      },
      mutations: { retry: false },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return;
        toast.error(mutation.meta?.failure ?? 'That didn’t work', errorMessage(error));
      },
    }),
  });
}
