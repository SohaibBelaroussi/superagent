// The task phase machine: which phases are open, and who may move a task from one phase to another.
// The API enforces it; clients use it to offer only the moves that will be accepted.
import type { TaskPhase } from './index';

export const TERMINAL_PHASES: ReadonlySet<TaskPhase> = new Set(['done', 'failed', 'cancelled']);
export const OPEN_PHASES: readonly TaskPhase[] = ['inbox', 'queued', 'working', 'waiting', 'review'];
export const BOARD_PHASES: readonly TaskPhase[] = [...OPEN_PHASES, 'done', 'failed', 'cancelled'];

/** Who moves a task: the owner (API, chief on their behalf), the department lead, or the server itself. */
export type PhaseActor = 'owner' | 'lead' | 'system';

const ALLOWED: Record<PhaseActor, Partial<Record<TaskPhase, readonly TaskPhase[]>>> = {
  // The owner sends work (back) to the lead, closes it, or cancels it.
  owner: {
    inbox: ['queued', 'cancelled'],
    queued: ['cancelled'],
    working: ['cancelled'],
    waiting: ['queued', 'cancelled'],
    review: ['done', 'queued', 'cancelled'],
    done: ['queued'],
    failed: ['queued', 'cancelled'],
  },
  // The lead reports progress and outcomes while the task is with it.
  lead: {
    queued: ['working', 'waiting', 'review', 'done', 'failed'],
    working: ['working', 'waiting', 'review', 'done', 'failed'],
    waiting: ['working', 'waiting', 'review', 'done', 'failed'],
  },
  // Dispatch and recovery: sending to the lead, and flagging runs that stopped without a report.
  system: {
    inbox: ['queued'],
    queued: ['working', 'waiting', 'failed'],
    working: ['waiting', 'failed'],
    waiting: ['working'],
  },
};

export function canTransition(actor: PhaseActor, from: TaskPhase, to: TaskPhase): boolean {
  return ALLOWED[actor][from]?.includes(to) ?? false;
}
