import { api, apiBlob, apiVoid, queryKeys } from '@superagent/client';
import { SandboxListSchema, WorkspaceListingSchema } from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/*
 * Workspaces: the files a task's agents wrote in its sandbox, and the sandboxes themselves. Reading
 * files never starts work, and works after the sandbox is gone.
 */

export const workspaceKeys = {
  /** Under the task's key: its events refresh the listing. */
  files: (taskId: string) => [...queryKeys.task(taskId), 'files'] as const,
  sandboxes: ['sandboxes'] as const,
};

const taskPath = (id: string, rest = '') => `/v1/tasks/${encodeURIComponent(id)}${rest}`;

/** What is directly in a folder of a task's workspace ("" for its own). */
export function useTaskFolder(taskId: string, path: string) {
  return useQuery({
    queryKey: [...workspaceKeys.files(taskId), path],
    queryFn: ({ signal }) =>
      api(WorkspaceListingSchema, taskPath(taskId, '/files'), {
        signal,
        query: { path: path || undefined, depth: 1 },
      }),
  });
}

/** A file of a task's workspace, as bytes. Its path keeps its slashes, each segment encoded. */
export function fetchTaskFile(taskId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return apiBlob(taskPath(taskId, `/files/${encoded}`), { signal });
}

/** The tasks' sandboxes: running, or stopped after a while idle. */
export function useSandboxes() {
  return useQuery({
    queryKey: workspaceKeys.sandboxes,
    queryFn: ({ signal }) => api(SandboxListSchema, '/v1/sandboxes', { signal }),
    select: (data) => data.items,
  });
}

/** Removes a task's sandbox container: its files stay, and its next command starts a fresh one. */
export function useRemoveSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiVoid(`/v1/sandboxes/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workspaceKeys.sandboxes }),
    meta: { failure: 'Couldn’t remove the sandbox' },
  });
}
