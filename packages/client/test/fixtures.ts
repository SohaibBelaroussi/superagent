import type { TaskEvent } from '@superagent/shared';

let counter = 0;

/** A task event, with what a test doesn't care about filled in. */
export function event(overrides: Partial<TaskEvent> & Pick<TaskEvent, 'type'>): TaskEvent {
  counter += 1;
  return {
    seq: counter,
    taskId: '0199b000-0000-7000-8000-000000000001',
    taskNumber: 1,
    departmentId: '0199a000-0000-7000-8000-000000000001',
    actor: 'owner',
    phase: 'queued',
    data: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
