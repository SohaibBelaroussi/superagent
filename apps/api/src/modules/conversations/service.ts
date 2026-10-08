import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
import type { Memory } from '@mastra/memory';
import type { ConversationPage, ConversationQuery, LiveEvent } from '@superagent/shared';
import type { TaskRow } from '../../db/schema';
import { CHIEF_THREAD, OWNER_RESOURCE } from '../dispatch/service';
import type { TaskService } from '../ledger/service';
import type { MemoryProfiles } from '../memory/profiles';
import {
  LiveNormalizer,
  normalizeMessage,
  reportNumbers,
  type StoredMessage,
  type TaskRef,
  type ThreadContext,
} from './normalize';

interface Thread {
  resourceId: string;
  threadId: string;
}

export interface ConversationDeps {
  mastra: Mastra;
  memory: MemoryProfiles;
  tasks: TaskService;
  /** The tool calls a task's lead waits on for the owner's approval (DispatchService.pendingApprovals). */
  approvals(task: TaskRow): Promise<Array<{ toolCallId: string }>>;
}

const CHIEF: Thread = { resourceId: OWNER_RESOURCE, threadId: CHIEF_THREAD };
const NO_TASKS: ReadonlyMap<number, TaskRef> = new Map();
const NO_CALLS: ReadonlySet<string> = new Set();
const chiefContext = (tasks = NO_TASKS): ThreadContext => ({
  kind: 'chief',
  authorAt: () => 'chief',
  tasks,
  waiting: NO_CALLS,
});
const threadOf = (task: TaskRow): Thread => ({ resourceId: task.resourceId, threadId: task.threadId });
const time = (message: StoredMessage) => new Date(message.createdAt).getTime();

/**
 * The owner's conversation with the chief of staff, and each task's transcript (its lead's thread):
 * their history page by page, and their runs live. The only module that subscribes to threads, an
 * experimental Mastra API (decision D22).
 */
export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  chiefPage(query: ConversationQuery): Promise<ConversationPage> {
    return this.page(this.deps.memory.chief, CHIEF, chiefContext, query);
  }

  async taskPage(task: TaskRow, query: ConversationQuery): Promise<ConversationPage> {
    const [leads, approvals] = await Promise.all([
      this.deps.tasks.leads(task.id),
      // Without them, a call waiting for approval reads as pending; never fails the page.
      this.deps.approvals(task).catch(() => []),
    ]);
    const waiting = new Set(approvals.map((approval) => approval.toolCallId));
    const context = (tasks: ReadonlyMap<number, TaskRef>): ThreadContext => ({
      kind: 'task',
      // The lead named by the last dispatch or reassignment before the message.
      authorAt: (at) =>
        leads.findLast((entry) => entry.since.getTime() <= at.getTime())?.lead ?? leads[0]?.lead ?? null,
      tasks,
      waiting,
    });
    return this.page(this.deps.memory.lead, threadOf(task), context, query);
  }

  followChief(signal: AbortSignal): AsyncGenerator<LiveEvent> {
    return this.follow(CHIEF, chiefContext(), signal);
  }

  followTask(task: TaskRow, signal: AbortSignal): AsyncGenerator<LiveEvent> {
    // Live, only what reaches the lead is a message; its own answers come as text and tool calls.
    return this.follow(
      threadOf(task),
      { kind: 'task', authorAt: () => null, tasks: NO_TASKS, waiting: NO_CALLS },
      signal,
    );
  }

  /**
   * The newest messages before `query.before`, oldest first. A full page leaves out the messages of its
   * oldest moment (the next page starts there), so messages that share a timestamp never fall between
   * two pages, unless a whole page shares one millisecond (Mastra spaces a turn's messages apart).
   */
  private async page(
    memory: Memory,
    thread: Thread,
    context: (tasks: ReadonlyMap<number, TaskRef>) => ThreadContext,
    query: ConversationQuery,
  ): Promise<ConversationPage> {
    if (!(await memory.getThreadById({ threadId: thread.threadId }))) return { items: [], nextCursor: null };
    const end = query.before ? new Date(query.before) : undefined;
    const { messages, hasMore } = await memory.recall({
      ...thread,
      perPage: query.limit,
      page: 0,
      hideSignals: false,
      includeTotal: false,
      ...(end ? { filter: { dateRange: { end } } } : {}),
    });
    let kept: StoredMessage[] = messages;
    let nextCursor: string | null = null;
    const oldest = kept[0];
    if (hasMore && oldest) {
      const newer = kept.filter((message) => time(message) !== time(oldest));
      if (newer.length > 0) {
        kept = newer;
        nextCursor = new Date(time(oldest)).toISOString();
      } else {
        nextCursor = new Date(time(oldest) - 1).toISOString();
      }
    }
    const full = context(await this.deps.tasks.refsByNumber(reportNumbers(kept)));
    return { items: kept.flatMap((message) => normalizeMessage(message, full) ?? []), nextCursor };
  }

  /** The thread's runs as live events, starting with `ready`, until `signal` aborts. */
  private async *follow(
    thread: Thread,
    context: ThreadContext,
    signal: AbortSignal,
  ): AsyncGenerator<LiveEvent> {
    if (signal.aborted) return;
    // Mastra's thread runtime is shared by all agents; the chief is always registered.
    const subscription = await (this.deps.mastra.getAgent('chief') as Agent).subscribeToThread(thread);
    const stop = () => subscription.unsubscribe();
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) return;
      yield { type: 'ready', running: subscription.activeRunId() !== null };
      const normalizer = new LiveNormalizer(context);
      for await (const chunk of subscription.stream) {
        for (const event of normalizer.push(chunk)) yield event;
      }
    } finally {
      signal.removeEventListener('abort', stop);
      subscription.unsubscribe();
    }
  }
}
