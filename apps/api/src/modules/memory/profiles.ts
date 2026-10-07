import type { IMastraLogger } from '@mastra/core/logger';
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
import { type OwnerProfile, OwnerProfileSchema } from '@superagent/shared';
import type { SettingsService } from '../settings/service';

/** The owner's profile is the working memory of the `owner` resource (the chief's). */
export const OWNER_PROFILE_AT = { threadId: 'owner-profile', resourceId: 'owner' } as const;

/** Where a department's notes live: the working memory of its resource, shared by all its task threads. */
export const departmentNotesAt = (slug: string) => ({
  threadId: `dept:${slug}:notes`,
  resourceId: `dept:${slug}`,
});

const DEPARTMENT_NOTES_TEMPLATE = `# Department notes
- Rules and preferences from the owner:
- What worked, what to avoid:
- Useful sources and contacts:
`;

export interface MemoryProfiles {
  /** The chief: history on chief:main, the owner profile, and compression. */
  chief: Memory;
  /** Leads: history per task thread, department notes shared across tasks, and compression. */
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

const hasThread = (context?: RequestContext) =>
  Boolean((context?.get('MastraMemory') as { thread?: { id?: string } } | undefined)?.thread?.id);

/**
 * Memory whose observational memory runs only for calls on a thread. Mastra's throws when there is
 * none (a direct /api/agents call, Studio without a thread), which would fail the whole call; without a
 * thread there is no history to compress anyway.
 */
class ThreadedMemory extends Memory {
  override async getInputProcessors(
    configured?: InputProcessorOrWorkflow[],
    context?: RequestContext,
  ): Promise<InputProcessor[]> {
    const processors = await super.getInputProcessors(configured, context);
    return hasThread(context) ? processors : processors.filter((p) => p.id !== 'observational-memory');
  }

  override async getOutputProcessors(
    configured?: OutputProcessorOrWorkflow[],
    context?: RequestContext,
  ): Promise<OutputProcessor[]> {
    const processors = await super.getOutputProcessors(configured, context);
    return hasThread(context) ? processors : processors.filter((p) => p.id !== 'observational-memory');
  }
}

/** One Memory per profile (decision D30), all on the same storage. Agents hold their instance directly. */
export function createMemoryProfiles(
  storage: MastraStorage,
  settings: SettingsService,
  options: MemoryOptions,
): MemoryProfiles {
  // Observational memory compresses long threads with the fast model, or the default one when no
  // fast model is set (an unresolvable model would stop every turn on the thread).
  const observational = (extra: { suggestedResponse?: boolean } = {}) => ({
    model: () => settings.modelRouterId(settings.get().models.fast ? 'fast' : 'default'),
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
      options: {
        lastMessages: 40,
        workingMemory: { enabled: true, scope: 'resource', schema: OwnerProfileSchema },
        observationalMemory: observational(),
      },
    }),
    lead: new ThreadedMemory({
      storage,
      options: {
        lastMessages: 40,
        workingMemory: { enabled: true, scope: 'resource', template: DEPARTMENT_NOTES_TEMPLATE },
        observationalMemory: observational({ suggestedResponse: false }),
      },
    }),
    specialist: new Memory({ storage, options: { lastMessages: 20 } }),
  };
}

/** The stored profile, or an empty one when there is none or it no longer fits the schema. */
export function parseProfile(raw: string | null, logger?: IMastraLogger): OwnerProfile {
  if (!raw) return {};
  try {
    const parsed = OwnerProfileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  logger?.warn('The stored owner profile is not valid; treating it as empty');
  return {};
}

/**
 * Gives department agents (leads and specialists) a read-only copy of the owner's profile, read per
 * run so changes apply at once. Specialists reached by delegation get it too.
 */
export class OwnerProfileProcessor implements Processor<'owner-profile'> {
  readonly id = 'owner-profile';

  constructor(
    private readonly chief: Memory,
    private readonly logger: IMastraLogger,
  ) {}

  async processInput({ messageList }: ProcessInputArgs) {
    const profile = parseProfile(await this.chief.getWorkingMemory(OWNER_PROFILE_AT), this.logger);
    if (Object.keys(profile).length > 0) {
      messageList.addSystem(
        `What you know about the owner (kept by the chief of staff, read-only for you):\n<owner_profile>\n${JSON.stringify(profile, null, 2)}\n</owner_profile>`,
        'owner-profile',
      );
    }
    return messageList;
  }
}
