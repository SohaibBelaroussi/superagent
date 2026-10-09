import {
  agentsQuery,
  attentionQuery,
  boardQuery,
  cancelTask,
  createTask,
  type DecisionRequest,
  decide,
  departmentsQuery,
  errorMessage,
  messageTask,
  ProblemError,
  profileQuery,
  recentTasksQuery,
  refreshDecided,
  refreshTask,
  taskArtifactsQuery,
  taskEventsQuery,
  taskQuery,
  updateTask,
  usageQuery,
} from '@superagent/client';
import type { TaskMessageInput, UpdateTaskInput, UsageGroup } from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '../ui/toast';

/*
 * The web app's hooks over the shared query definitions (`@superagent/client`): what each asks for
 * is shared with the phone app; toasts and other reactions are the web app's.
 */

/**
 * Every department, archived ones included: tasks and history still name them. Lists you pick from
 * use `useOrg().departments`, the active ones.
 */
export function useDepartments() {
  return useQuery(departmentsQuery());
}

/** Every agent, archived ones included (as for departments), each with its active version. */
export function useAgents() {
  return useQuery(agentsQuery());
}

/** The board: open tasks and tasks closed this week, by phase. `undefined`: every department. */
export function useBoard(departmentId?: string) {
  return useQuery(boardQuery(departmentId));
}

export function useRecentTasks(limit = 20) {
  return useQuery(recentTasksQuery(limit));
}

export function useTask(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({ ...taskQuery(id), enabled: options.enabled ?? true });
}

/** A task's whole history, oldest first, fetched incrementally (see `taskEventsQuery`). */
export function useTaskEvents(id: string) {
  const queryClient = useQueryClient();
  return useQuery(taskEventsQuery(id, queryClient));
}

export function useTaskArtifacts(id: string) {
  return useQuery(taskArtifactsQuery(id));
}

/** What needs you. `inBackground` keeps looking while the tab is hidden (for notifications). */
export function useAttention(options: { inBackground?: boolean } = {}) {
  return useQuery({ ...attentionQuery(), refetchIntervalInBackground: options.inBackground ?? false });
}

export function useProfile() {
  return useQuery(profileQuery());
}

/** Tokens and cost since `from`, grouped by `group`. */
export function useUsage(group: UsageGroup, from?: string, enabled = true) {
  return useQuery({ ...usageQuery(group, from), enabled });
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

/** Approve or decline a tool call waiting for you. */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: decide,
    onSuccess: (_decision, { item }: DecisionRequest) => refreshDecided(queryClient, item),
    onError: (error, { item }) => {
      // Decided already (another tab, another device): nothing to undo, just show where things stand.
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
