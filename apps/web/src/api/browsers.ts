import {
  BrowserIdentitySchema,
  BrowserSessionListSchema,
  BrowserSessionSchema,
  type CreateBrowserIdentityInput,
} from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiVoid, ProblemError } from './client';
import { queryKeys } from './queries';

/*
 * Browsers: identities (signed-in profiles agents can browse as), the owner's sign-in sessions, and
 * the browsers open now. Their live views are WebSockets (`features/browsers/live-view.tsx`).
 */

export const browserKeys = {
  identities: queryKeys.identities,
  identity: (id: string) => [...queryKeys.identities, id] as const,
  open: ['browsers'] as const,
  /** Under the task's key: its events refresh it. */
  ofTask: (taskId: string) => [...queryKeys.task(taskId), 'browser'] as const,
};

/** How often to look at the open browsers again while they're listed: none of their changes is evented. */
const OPEN_BROWSERS_MS = 10_000;

const identityPath = (id: string, rest = '') => `/v1/browser-identities/${encodeURIComponent(id)}${rest}`;

function refreshBrowsers(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: browserKeys.identities });
  void queryClient.invalidateQueries({ queryKey: browserKeys.open });
}

/** One identity (nothing is asked for without an id). */
export function useBrowserIdentity(id: string) {
  return useQuery({
    queryKey: browserKeys.identity(id),
    queryFn: ({ signal }) => api(BrowserIdentitySchema, identityPath(id), { signal }),
    enabled: id !== '',
  });
}

export function useCreateIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBrowserIdentityInput) =>
      api(BrowserIdentitySchema, '/v1/browser-identities', { method: 'POST', json: input }),
    onSuccess: () => refreshBrowsers(queryClient),
    meta: { silent: true },
  });
}

export function useDeleteIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(identityPath(id), { method: 'DELETE' }),
    onSuccess: () => refreshBrowsers(queryClient),
    meta: { failure: 'Couldn’t delete the identity' },
  });
}

/** Opens an identity's browser for the owner to sign in to sites in, through its live view. */
export function useOpenSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(BrowserSessionSchema, identityPath(id, '/session'), { method: 'POST' }),
    onSuccess: () => refreshBrowsers(queryClient),
    meta: { failure: 'Couldn’t open its browser' },
  });
}

/** Closes a sign-in session; its cookies are saved first. */
export function useCloseSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(identityPath(id, '/session'), { method: 'DELETE' }),
    onSuccess: () => refreshBrowsers(queryClient),
    meta: { failure: 'Couldn’t close its browser' },
  });
}

/** The browsers open now: tasks', sign-in sessions, and the page reader. */
export function useOpenBrowsers() {
  return useQuery({
    queryKey: browserKeys.open,
    queryFn: ({ signal }) => api(BrowserSessionListSchema, '/v1/browsers', { signal }),
    select: (data) => data.items,
    refetchInterval: OPEN_BROWSERS_MS,
  });
}

/** A task's browser, or null while none is open. */
export function useTaskBrowser(taskId: string) {
  return useQuery({
    queryKey: browserKeys.ofTask(taskId),
    queryFn: async ({ signal }) => {
      try {
        return await api(BrowserSessionSchema, `/v1/tasks/${encodeURIComponent(taskId)}/browser`, { signal });
      } catch (error) {
        if (error instanceof ProblemError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** Closes a task's browser: its identity's cookies are saved, and an agent's next call opens a new one. */
export function useCloseTaskBrowser(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiVoid(`/v1/tasks/${encodeURIComponent(taskId)}/browser`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.setQueryData(browserKeys.ofTask(taskId), null);
      // Its identity is free again, as well as gone from the open browsers.
      refreshBrowsers(queryClient);
    },
    meta: { failure: 'Couldn’t close the browser' },
  });
}
