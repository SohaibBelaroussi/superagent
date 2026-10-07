import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { OwnerProfilePatchSchema } from '@superagent/shared';
import { z } from 'zod';
import type { OrgDirectory } from '../org/directory';
import type { MemoryService } from './service';

/** The tools that write memory, all through MemoryService (decision D30). */
export function createMemoryTools(
  memory: MemoryService,
  directory: OrgDirectory,
): { chief: ToolsInput; lead: ToolsInput } {
  return {
    chief: {
      update_owner_profile: createTool({
        id: 'update_owner_profile',
        description:
          'Save what you learn about the owner: name, language, how they like answers, preferences, background. ' +
          'Fields given replace the stored ones (a list replaces the whole list); null removes a field.',
        inputSchema: OwnerProfilePatchSchema,
        execute: async (input) => ({ profile: await memory.updateProfile(input) }),
      }),
    },
    lead: {
      save_department_note: createTool({
        id: 'save_department_note',
        description:
          "Add one short line to your department's notes: a rule from the owner or a lesson worth keeping. " +
          'Every task of the department sees the notes.',
        inputSchema: z.object({ note: z.string().min(1).max(500) }),
        execute: async ({ note }, context) => {
          const key = (context as { agent?: { agentId?: string } } | undefined)?.agent?.agentId;
          const agent = key ? directory.agentByKey(key) : undefined;
          if (!agent) throw new Error('Only department leads keep department notes.');
          await memory.addDepartmentNote(agent.departmentId, note);
          return { saved: true };
        },
      }),
    },
  };
}
