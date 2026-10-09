import {
  AgentListSchema,
  ArtifactListSchema,
  type AttentionItem,
  type AttentionList,
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
import type { QueryClient, QueryFunctionContext } from '@tanstack/query-core';
import type { z } from 'zod';
import { api } from './http';
import { randomId } from './id';

/**
 * Query keys. Prefixes invalidate everything under them: `['task', id]` covers its events too. Both
 * apps use these, so a change made by one hook refreshes what the others show.
 */
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
  agentVersions: (id: string) => ['agents', id, 'versions'] as const,
  departmentNotes: (id: string) => ['departments', id, 'notes'] as const,
  capabilities: ['capabilities'] as const,
  identities: ['browser-identities'] as const,
  settings: ['settings'] as const,
  providers: ['providers'] as const,
  providerModels: (id: string) => ['providers', id, 'models'] as const,
  usage: ['usage'] as const,
  schedules: ['schedules'] as const,
  knowledge: ['knowledge'] as const,
};

type Context = Pick<QueryFunctionContext, 'signal'>;
type DepartmentList = z.infer<typeof DepartmentListSchema>;
type AgentList = z.infer<typeof AgentListSchema>;
type TaskList = z.infer<typeof TaskListSchema>;
type ArtifactList = z.infer<typeof ArtifactListSchema>;

/*
 * What each query asks for, as TanStack query options: each app's hooks pass them to its `useQuery`
 * (`useQuery(boardQuery(id))`), so the web app and the phone ask for the same data under the same keys.
 */

/**
 * Every department, archived ones included: tasks and history still name them. Lists you pick from
 * use the active ones.
 */
export const departmentsQuery = () => ({
  queryKey: queryKeys.departments,
  queryFn: ({ signal }: Context) =>
    api(DepartmentListSchema, '/v1/departments', { signal, query: { includeArchived: true } }),
  select: (data: DepartmentList) => data.items,
  staleTime: 5 * 60_000,
});

/** Every agent, archived ones included (as for departments), each with its active version. */
export const agentsQuery = () => ({
  queryKey: queryKeys.agents,
  queryFn: ({ signal }: Context) =>
    api(AgentListSchema, '/v1/agents', { signal, query: { includeArchived: true } }),
  select: (data: AgentList) => data.items,
  staleTime: 5 * 60_000,
});

/** The board: open tasks and tasks closed this week, by phase. `undefined`: every department. */
export const boardQuery = (departmentId?: string) => ({
  queryKey: [...queryKeys.board, departmentId ?? 'all'] as const,
  queryFn: ({ signal }: Context) =>
    api(BoardSchema, '/v1/board', { signal, query: departmentId ? { departmentId } : undefined }),
});

export const recentTasksQuery = (limit = 20) => ({
  queryKey: queryKeys.tasks({ limit }),
  queryFn: ({ signal }: Context) => api(TaskListSchema, '/v1/tasks', { signal, query: { limit } }),
  select: (data: TaskList) => data.items,
});

/** A task's path in the API. Ids come from URLs too: encoded, so one can never name another route. */
export const taskPath = (id: string, rest = '') => `/v1/tasks/${encodeURIComponent(id)}${rest}`;

export const taskQuery = (id: string) => ({
  queryKey: queryKeys.task(id),
  queryFn: ({ signal }: Context) => api(TaskSchema, taskPath(id), { signal }),
});

const EVENT_PAGE = 1000;
const EVENT_PAGES_PER_FETCH = 20;

/**
 * A task's whole history, oldest first. The log only grows, so each refetch asks only for what comes
 * after the last event already here, page by page: a long task still shows its newest events, and a
 * live update costs one small request.
 */
export const taskEventsQuery = (id: string, queryClient: QueryClient) => ({
  queryKey: queryKeys.taskEvents(id),
  queryFn: async ({ signal }: Context): Promise<TaskEvent[]> => {
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

export const taskArtifactsQuery = (id: string) => ({
  queryKey: queryKeys.taskArtifacts(id),
  queryFn: ({ signal }: Context) => api(ArtifactListSchema, taskPath(id, '/artifacts'), { signal }),
  select: (data: ArtifactList) => data.items,
});

/** What needs you. Health items don't arrive as task events, so it looks again now and then. */
export const attentionQuery = () => ({
  queryKey: queryKeys.attention,
  queryFn: ({ signal }: Context) => api(AttentionListSchema, '/v1/attention', { signal }),
  select: (data: AttentionList) => data.items,
  refetchInterval: 60_000,
});

export const profileQuery = () => ({
  queryKey: queryKeys.profile,
  queryFn: ({ signal }: Context) => api(OwnerProfileSchema, '/v1/profile', { signal }),
  staleTime: 10 * 60_000,
});

/** Tokens and cost since `from`, grouped by `group`. */
export const usageQuery = (group: UsageGroup, from?: string) => ({
  queryKey: [...queryKeys.usage, group, from ?? 'all'] as const,
  queryFn: ({ signal }: Context) => api(UsageReportSchema, '/v1/usage', { signal, query: { group, from } }),
  staleTime: 60_000,
});

/** After a change to a task: its own queries, and every list it appears in. */
export function refreshTask(queryClient: QueryClient, task: Task): void {
  queryClient.setQueryData(queryKeys.task(task.id), task);
  void queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
}

/* Changes, for each app's mutations (`useMutation({ mutationFn: createTask, ... })`). */

export const createTask = (input: z.input<typeof CreateTaskInputSchema>) =>
  api(TaskSchema, '/v1/tasks', { method: 'POST', json: input });

export const updateTask = (id: string, input: UpdateTaskInput) =>
  api(TaskSchema, taskPath(id), { method: 'PATCH', json: input });

export const cancelTask = (id: string, reason?: string) =>
  api(TaskSchema, taskPath(id, '/cancel'), { method: 'POST', json: reason ? { reason } : {} });

export const messageTask = (id: string, input: TaskMessageInput) =>
  api(TaskSchema, taskPath(id, '/messages'), { method: 'POST', json: input });

export interface DecisionRequest {
  item: Pick<AttentionItem, 'id' | 'taskId'>;
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
export const decide = ({ item, kind, reason, key }: DecisionRequest) =>
  api(DecisionSchema, `/v1/attention/${encodeURIComponent(item.id)}/${kind}`, {
    method: 'POST',
    json: kind === 'decline' && reason?.trim() ? { reason: reason.trim() } : undefined,
    headers: { 'idempotency-key': key },
  });

/** After a decision (or a 409: decided elsewhere): what needs you, its task, and the board. */
export function refreshDecided(queryClient: QueryClient, item: DecisionRequest['item']): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
  if (item.taskId) void queryClient.invalidateQueries({ queryKey: queryKeys.task(item.taskId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.board });
}
