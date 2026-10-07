import { EventEmitter } from 'node:events';
import type { TaskEvent } from '@superagent/shared';

/** In-process fan-out of committed task events to live SSE streams (single API process, decision D23). */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: TaskEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

export interface EventFilter {
  departmentId?: string;
  taskId?: string;
}

export function matchesFilter(event: TaskEvent, filter: EventFilter): boolean {
  return (
    (!filter.departmentId || event.departmentId === filter.departmentId) &&
    (!filter.taskId || event.taskId === filter.taskId)
  );
}
