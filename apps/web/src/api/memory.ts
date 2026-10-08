import { DepartmentMemorySchema, type OwnerProfilePatch, OwnerProfileSchema } from '@superagent/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './queries';

/*
 * What the agents remember: your profile (the chief keeps it, every agent reads it) and each
 * department's notes (its lead keeps them). Both are written by agents too, so an edit checks what it
 * started from before replacing it.
 */

const notesPath = (id: string) => `/v1/departments/${encodeURIComponent(id)}/memory`;

const notesQuery = (id: string) => ({
  queryKey: queryKeys.departmentNotes(id),
  queryFn: ({ signal }: { signal?: AbortSignal }) => api(DepartmentMemorySchema, notesPath(id), { signal }),
});

/** A department's notes (markdown), null before its lead writes any. */
export function useDepartmentNotes(id: string) {
  return useQuery({ ...notesQuery(id), select: (data) => data.notes });
}

/** The notes as the server has them now, for checking nobody changed them during an edit. */
export async function latestNotes(queryClient: QueryClient, id: string): Promise<string | null> {
  const memory = await queryClient.fetchQuery({ ...notesQuery(id), staleTime: 0 });
  return memory.notes;
}

export function useSaveDepartmentNotes(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notes: string) =>
      api(DepartmentMemorySchema, notesPath(id), { method: 'PUT', json: { notes } }),
    onSuccess: (memory) => queryClient.setQueryData(queryKeys.departmentNotes(id), memory),
    meta: { failure: 'Couldn’t save the notes' },
  });
}

/** Changes your profile: fields given replace the stored ones, null removes one. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: OwnerProfilePatch) =>
      api(OwnerProfileSchema, '/v1/profile', { method: 'PATCH', json: patch }),
    onSuccess: (profile) => queryClient.setQueryData(queryKeys.profile, profile),
    meta: { failure: 'Couldn’t save your profile' },
  });
}
