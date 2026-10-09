import {
  agentsQuery,
  attentionQuery,
  boardQuery,
  cancelTask,
  createOrgLookup,
  createTask,
  type DecisionRequest,
  decide,
  departmentsQuery,
  errorMessage,
  messageTask,
  type OrgLookup,
  ProblemError,
  recentTasksQuery,
  refreshDecided,
  refreshTask,
  taskArtifactsQuery,
  taskEventsQuery,
  taskQuery,
  updateTask,
} from '@superagent/client';
import type { TaskMessageInput, UpdateTaskInput } from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from '../ui/toast';

/*
 * The phone's hooks over the shared query definitions (`@superagent/client`): the same requests, under
 * the same keys, as the web app's. Reactions (toasts, haptics) are the phone's own.
 */

export function useDepartments() {
  return useQuery(departmentsQuery());
}

export function useAgents() {
  return useQuery(agentsQuery());
}

export function useBoard(departmentId?: string) {
  return useQuery(boardQuery(departmentId));
}

export function useRecentTasks(limit = 20) {
  return useQuery(recentTasksQuery(limit));
}

export function useTask(id: string) {
  return useQuery(taskQuery(id));
}

export function useTaskEvents(id: string) {
  const queryClient = useQueryClient();
  return useQuery(taskEventsQuery(id, queryClient));
}

export function useTaskArtifacts(id: string) {
  return useQuery(taskArtifactsQuery(id));
}

/** What needs you, refreshed by task events, and every minute for setup problems. */
export function useAttention() {
  return useQuery(attentionQuery());
}

/** Departments and agents by id, slug and key. */
export function useOrg(): OrgLookup {
  const departments = useDepartments();
  const agents = useAgents();
  return useMemo(
    () => ({
      ...createOrgLookup(departments.data, agents.data),
      ready: departments.isSuccess && agents.isSuccess,
      fetching: departments.isFetching || agents.isFetching,
      error: (departments.data ? null : departments.error) ?? (agents.data ? null : agents.error),
      refetch: () => {
        void departments.refetch();
        void agents.refetch();
      },
    }),
    [
      departments.data,
      departments.isSuccess,
      departments.isFetching,
      departments.error,
      departments.refetch,
      agents.data,
      agents.isSuccess,
      agents.isFetching,
      agents.error,
      agents.refetch,
    ],
  );
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTask,
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { silent: true },
  });
}

export function useUpdateTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(id, input),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t update the task' },
  });
}

export function useCancelTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => cancelTask(id, reason),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t cancel the task' },
  });
}

/** Approve or decline a tool call waiting for you. A 409 means it was decided elsewhere. */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: decide,
    onSuccess: (_decision, { item }: DecisionRequest) => refreshDecided(queryClient, item),
    onError: (error, { item }) => {
      if (error instanceof ProblemError && error.status === 409) {
        refreshDecided(queryClient, item);
        toast.info('Already decided', 'This call was decided elsewhere.');
        return;
      }
      toast.error('Couldn’t record your decision', errorMessage(error));
    },
    meta: { silent: true },
  });
}

export function useMessageTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskMessageInput) => messageTask(id, input),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t send the message' },
  });
}
