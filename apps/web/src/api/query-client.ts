import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from '../ui/toast';
import { errorMessage, ProblemError } from './client';

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

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Live events refresh what changes; this only bounds how stale a page can be after a gap.
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
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
