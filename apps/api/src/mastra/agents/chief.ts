import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { OrgDirectory } from '../../modules/org/directory';
import { chiefInstructions } from '../../modules/org/instructions';
import type { SettingsService } from '../../modules/settings/service';
import type { ToolCatalog } from '../../modules/tools/catalog';

/**
 * The owner's single point of contact, defined in code. Knows the organization (read per request) and
 * runs it through the ledger tools: create, inspect, message and cancel tasks.
 */
export function createChiefAgent(deps: {
  directory: OrgDirectory;
  settings: SettingsService;
  catalog: ToolCatalog;
  memory: Memory;
  chiefTools: ToolsInput;
}): Agent {
  return new Agent({
    id: 'chief',
    name: 'Chief of staff',
    description: "The owner's chief of staff: knows every department and routes work to them.",
    instructions: () => chiefInstructions(deps.directory),
    model: () => deps.settings.modelRouterId('default'),
    tools: { ...deps.catalog.build([{ key: 'current_time', requireApproval: false }]), ...deps.chiefTools },
    memory: deps.memory,
    defaultOptions: { maxSteps: 8 },
  });
}
