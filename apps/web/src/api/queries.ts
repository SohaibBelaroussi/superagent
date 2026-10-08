import {
  AgentListSchema,
  ArtifactListSchema,
  type AttentionItem,
  AttentionListSchema,
  BoardSchema,
  type CreateTaskInputSchema,
  DecisionSchema,
  DepartmentListSchema,
  OwnerProfileSchema,
  type Task,
  type TaskEvent,
  TaskEventListSchema,
  TaskListSchema,
  type TaskMessageInput,
  TaskSchema,
  type UpdateTaskInput,
  type UsageGroup,
  UsageReportSchema,
} from '@superagent/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { randomId } from '../lib/id';
import { toast } from '../ui/toast';
import { api, errorMessage, ProblemError } from './client';

/** Query keys. Prefixes invalidate everything under them: `['task', id]` covers its events too. */
export const queryKeys = {
  departments: ['departments'] as const,
  agents: ['agents'] as const,
  board: ['board'] as const,
  tasks: (filter?: Record<string, unknown>) => (filter ? (['tasks', filter] as const) : (['tasks'] as const)),
  task: (id: string) => ['task', id] as const,
  taskEvents: (id: string) => ['task', id, 'events'] as const,
  taskArtifacts: (id: string) => ['task', id, 'artifacts'] as const,
  attention: ['attention'] as const,
  profile: ['profile'] as const,
};

export function useDepartments() {
  return useQuery({
    queryKey: queryKeys.departments,
    queryFn: ({ signal }) => api(DepartmentListSchema, '/v1/departments', { signal }),
    select: (data) => data.items,
    staleTime: 5 * 60_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api(AgentListSchema, '/v1/agents', { signal }),
    select: (data) => data.items,
    staleTime: 5 * 60_000,
  });
}

/** The board: open tasks and tasks closed this week, by phase. `undefined`: every department. */
export function useBoard(departmentId?: string) {
  return useQuery({
    queryKey: [...queryKeys.board, departmentId ?? 'all'],
    queryFn: ({ signal }) =>
      api(BoardSchema, '/v1/board', { signal, query: departmentId ? { departmentId } : undefined }),
  });
}

export function useRecentTasks(limit = 20) {
  return useQuery({
    queryKey: queryKeys.tasks({ limit }),
    queryFn: ({ signal }) => api(TaskListSchema, '/v1/tasks', { signal, query: { limit } }),
    select: (data) => data.items,
  });
}

/** A task's path in the API. Ids come from URLs too: encoded, so one can never name another route. */
const taskPath = (id: string, rest = '') => `/v1/tasks/${encodeURIComponent(id)}${rest}`;

export function useTask(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.task(id),
    queryFn: ({ signal }) => api(TaskSchema, taskPath(id), { signal }),
    enabled: options.enabled ?? true,
  });
}

const EVENT_PAGE = 1000;
const EVENT_PAGES_PER_FETCH = 20;

/**
 * A task's whole history, oldest first. The log only grows, so each refetch asks only for what comes
 * after the last event already here, page by page: a long task still shows its newest events, and a
 * live update costs one small request.
 */
export function useTaskEvents(id: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.taskEvents(id),
    queryFn: async ({ signal }) => {
      const known = queryClient.getQueryData<TaskEvent[]>(queryKeys.taskEvents(id)) ?? [];
      const events = [...known];
      let after = known.at(-1)?.seq;
      for (let page = 0; page < EVENT_PAGES_PER_FETCH; page += 1) {
        const { items } = await api(TaskEventListSchema, taskPath(id, '/events'), {
          signal,
          query: { limit: EVENT_PAGE, after },
        });
        events.push(...items);
        if (items.length < EVENT_PAGE) break;
        after = items.at(-1)?.seq;
      }
      return events;
    },
  });
}

export function useTaskArtifacts(id: string) {
  return useQuery({
    queryKey: queryKeys.taskArtifacts(id),
    queryFn: ({ signal }) => api(ArtifactListSchema, taskPath(id, '/artifacts'), { signal }),
    select: (data) => data.items,
  });
}

export function useAttention() {
  return useQuery({
    queryKey: queryKeys.attention,
    queryFn: ({ signal }) => api(AttentionListSchema, '/v1/attention', { signal }),
    select: (data) => data.items,
    // Health items don't arrive as task events: look again now and then.
    refetchInterval: 60_000,
  });
}

export function useProfile() {
  return useQuery({
    queryKey: queryKeys.profile,
    queryFn: ({ signal }) => api(OwnerProfileSchema, '/v1/profile', { signal }),
    staleTime: 10 * 60_000,
  });
}

/** Tokens and cost since `from`, grouped by `group`. */
export function useUsage(group: UsageGroup, from?: string) {
  return useQuery({
    queryKey: ['usage', group, from ?? 'all'],
    queryFn: ({ signal }) => api(UsageReportSchema, '/v1/usage', { signal, query: { group, from } }),
    staleTime: 60_000,
  });
}

/** After a change to a task: its own queries, and every list it appears in. */
export function refreshTask(queryClient: QueryClient, task: Task): void {
  queryClient.setQueryData(queryKeys.task(task.id), task);
  void queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateTaskInputSchema>) =>
      api(TaskSchema, '/v1/tasks', { method: 'POST', json: input }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { silent: true },
  });
}

export function useUpdateTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => api(TaskSchema, taskPath(id), { method: 'PATCH', json: input }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t update the task' },
  });
}

export function useCancelTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      api(TaskSchema, taskPath(id, '/cancel'), { method: 'POST', json: reason ? { reason } : {} }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t cancel the task' },
  });
}

export interface DecisionRequest {
  item: AttentionItem;
  kind: 'approve' | 'decline';
  reason?: string;
  /**
   * The same key for every attempt at one decision (a retry after a lost answer), so the server applies
   * it once and answers the retry with the first outcome. `decisionKey()` makes one.
   */
  key: string;
}

export const decisionKey = randomId;

/** Approve or decline a tool call waiting for you. */
export function useDecide() {
  const queryClient = useQueryClient();
  const refresh = (item: AttentionItem) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
    if (item.taskId) void queryClient.invalidateQueries({ queryKey: queryKeys.task(item.taskId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  };
  return useMutation({
    mutationFn: ({ item, kind, reason, key }: DecisionRequest) =>
      api(DecisionSchema, `/v1/attention/${encodeURIComponent(item.id)}/${kind}`, {
        method: 'POST',
        json: kind === 'decline' && reason?.trim() ? { reason: reason.trim() } : undefined,
        headers: { 'idempotency-key': key },
      }),
    onSuccess: (_decision, { item }) => refresh(item),
    onError: (error, { item }) => {
      // Decided already (another tab, another device): nothing to undo, just show where things stand.
      if (error instanceof ProblemError && error.status === 409) {
        refresh(item);
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
    mutationFn: (input: TaskMessageInput) =>
      api(TaskSchema, taskPath(id, '/messages'), { method: 'POST', json: input }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t send the message' },
  });
}
