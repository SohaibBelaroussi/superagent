import type {
  InputProcessor,
  InputProcessorOrWorkflow,
  OutputProcessor,
  OutputProcessorOrWorkflow,
  ProcessInputArgs,
  Processor,
} from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraStorage } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import type { MemoryService } from './service';

export interface MemoryProfiles {
  /** The chief: history on chief:main, compressed when long. */
  chief: Memory;
  /** Leads: history per task thread, compressed when long. */
  lead: Memory;
  /** Specialists: short history of their delegations only. */
  specialist: Memory;
}

export interface MemoryOptions {
  /** Unobserved message tokens in a thread before it is compressed into observations. */
  observeTokens: number;
  /** Observation tokens before they are condensed in turn. */
  reflectTokens: number;
  /** Observe in the background as a thread grows (true), or only when the threshold is reached. */
  observeAhead: boolean;
}

type HookArgs = {
  requestContext?: RequestContext;
  messageList?: { serialize?: () => { memoryInfo?: { threadId?: string } } };
};

/** Mirrors how observational memory finds the thread: the run's memory context, then the message list. */
const onThread = (args: HookArgs) =>
  Boolean(
    (args.requestContext?.get('MastraMemory') as { thread?: { id?: string } } | undefined)?.thread?.id,
  ) || Boolean(args.messageList?.serialize?.()?.memoryInfo?.threadId);

/**
 * Observational memory throws on calls without a thread (a direct /api/agents call, Studio), failing
 * the whole call. Its hooks pass such calls through instead; the processor stays listed, so Mastra's
 * memory routes still find it.
 */
function passThroughWithoutThread<T extends { id: string }>(processor: T): T {
  if (processor.id !== 'observational-memory') return processor;
  return new Proxy(processor, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === 'processInputStep' || prop === 'processOutputResult') && typeof value === 'function') {
        return (args: HookArgs) => (onThread(args) ? value.call(target, args) : args.messageList);
      }
      return value;
    },
  });
}

class ThreadedMemory extends Memory {
  override async getInputProcessors(
    configured?: InputProcessorOrWorkflow[],
    context?: RequestContext,
  ): Promise<InputProcessor[]> {
    return (await super.getInputProcessors(configured, context)).map(passThroughWithoutThread);
  }

  override async getOutputProcessors(
    configured?: OutputProcessorOrWorkflow[],
    context?: RequestContext,
  ): Promise<OutputProcessor[]> {
    return (await super.getOutputProcessors(configured, context)).map(passThroughWithoutThread);
  }
}

/**
 * One Memory per profile (decision D30), all on the same storage. Agents hold their instance directly.
 * `observerModel` picks the model that compresses long threads, at the moment it is needed.
 */
export function createMemoryProfiles(
  storage: MastraStorage,
  observerModel: () => string,
  options: MemoryOptions,
): MemoryProfiles {
  const observational = (extra: { suggestedResponse?: boolean } = {}) => ({
    model: observerModel,
    observation: {
      messageTokens: options.observeTokens,
      ...(options.observeAhead ? {} : { bufferTokens: false as const }),
      failurePolicy: 'continue' as const,
      ...(extra.suggestedResponse === false ? { continuationHints: { suggestedResponse: false } } : {}),
    },
    reflection: { observationTokens: options.reflectTokens, failurePolicy: 'continue' as const },
  });
  return {
    chief: new ThreadedMemory({
      storage,
      options: { lastMessages: 40, observationalMemory: observational() },
    }),
    lead: new ThreadedMemory({
      storage,
      options: { lastMessages: 40, observationalMemory: observational({ suggestedResponse: false }) },
    }),
    specialist: new Memory({ storage, options: { lastMessages: 20 } }),
  };
}

/**
 * The owner's profile in an agent's context, read per run so changes apply at once. The chief may
 * update it; department agents (leads and the specialists they delegate to) only read it.
 */
export class OwnerProfileProcessor implements Processor<'owner-profile'> {
  readonly id = 'owner-profile';

  constructor(
    private readonly memory: MemoryService,
    private readonly editable: boolean,
  ) {}

  async processInput({ messageList }: ProcessInputArgs) {
    const profile = await this.memory.profile();
    if (this.editable || Object.keys(profile).length > 0) {
      const heading = this.editable
        ? 'What you know about the owner. Keep it current with update_owner_profile whenever they tell you about themselves or how they like things done; every department reads it:'
        : 'What you know about the owner (kept by the chief of staff, read-only for you):';
      messageList.addSystem(
        `${heading}\n<owner_profile>\n${JSON.stringify(profile, null, 2)}\n</owner_profile>`,
        'owner-profile',
      );
    }
    return messageList;
  }
}

/** A lead's department notes in its context, read per run so the owner's corrections apply at once. */
export class DepartmentNotesProcessor implements Processor<'department-notes'> {
  readonly id = 'department-notes';

  constructor(
    private readonly memory: MemoryService,
    private readonly departmentId: string,
  ) {}

  async processInput({ messageList }: ProcessInputArgs) {
    const notes = await this.memory.departmentNotes(this.departmentId).catch(() => null);
    if (notes) {
      messageList.addSystem(
        `Your department's notes, shared by all of its tasks. Follow every rule in them:\n<department_notes>\n${notes}\n</department_notes>`,
        'department-notes',
      );
    }
    return messageList;
  }
}
