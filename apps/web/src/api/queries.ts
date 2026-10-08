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
import { api } from './client';

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

export function useTask(id: string) {
  return useQuery({
    queryKey: queryKeys.task(id),
    queryFn: ({ signal }) => api(TaskSchema, `/v1/tasks/${id}`, { signal }),
  });
}

export function useTaskEvents(id: string) {
  return useQuery({
    queryKey: queryKeys.taskEvents(id),
    queryFn: ({ signal }) =>
      api(TaskEventListSchema, `/v1/tasks/${id}/events`, { signal, query: { limit: 1000 } }),
    select: (data) => data.items,
  });
}

export function useTaskArtifacts(id: string) {
  return useQuery({
    queryKey: queryKeys.taskArtifacts(id),
    queryFn: ({ signal }) => api(ArtifactListSchema, `/v1/tasks/${id}/artifacts`, { signal }),
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
    mutationFn: (input: UpdateTaskInput) =>
      api(TaskSchema, `/v1/tasks/${id}`, { method: 'PATCH', json: input }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t update the task' },
  });
}

export function useCancelTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      api(TaskSchema, `/v1/tasks/${id}/cancel`, { method: 'POST', json: reason ? { reason } : {} }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t cancel the task' },
  });
}

/** Approve or decline a tool call waiting for you. Each decision carries its own idempotency key. */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      item,
      kind,
      reason,
    }: {
      item: AttentionItem;
      kind: 'approve' | 'decline';
      reason?: string;
    }) =>
      api(DecisionSchema, `/v1/attention/${encodeURIComponent(item.id)}/${kind}`, {
        method: 'POST',
        json: kind === 'decline' && reason?.trim() ? { reason: reason.trim() } : undefined,
        headers: { 'idempotency-key': randomId() },
      }),
    onSuccess: (_decision, { item }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
      if (item.taskId) void queryClient.invalidateQueries({ queryKey: queryKeys.task(item.taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    meta: { failure: 'Couldn’t record your decision' },
  });
}

export function useMessageTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskMessageInput) =>
      api(TaskSchema, `/v1/tasks/${id}/messages`, { method: 'POST', json: input }),
    onSuccess: (task) => refreshTask(queryClient, task),
    meta: { failure: 'Couldn’t send the message' },
  });
}
