import { api, apiVoid, queryKeys, refreshTask } from '@superagent/client';
import {
  type CreateScheduleInputSchema,
  ScheduleListSchema,
  ScheduleSchema,
  TaskSchema,
  type UpdateScheduleInput,
} from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

const schedulePath = (id: string, rest = '') => `/v1/schedules/${encodeURIComponent(id)}${rest}`;

/** Every schedule, newest first (a department's page filters them). Agents make them too. */
export function useSchedules() {
  return useQuery({
    queryKey: queryKeys.schedules,
    queryFn: ({ signal }) => api(ScheduleListSchema, '/v1/schedules', { signal }),
    select: (data) => data.items,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateScheduleInputSchema>) =>
      api(ScheduleSchema, '/v1/schedules', { method: 'POST', json: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
    meta: { silent: true },
  });
}

/** Edits a schedule, or pauses and resumes it (`status`). */
export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateScheduleInput & { id: string }) =>
      api(ScheduleSchema, schedulePath(id), { method: 'PATCH', json: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
    meta: { silent: true },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(schedulePath(id), { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
    meta: { failure: 'Couldn’t delete the schedule' },
  });
}

/** Fires a schedule now: its task goes to the department's lead. */
export function useRunSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(TaskSchema, schedulePath(id, '/run'), { method: 'POST' }),
    onSuccess: (task) => {
      refreshTask(queryClient, task);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
    meta: { failure: 'Couldn’t run the schedule' },
  });
}
