import type {
  AgentDefinition,
  AgentVersion,
  Department,
  McpGrant,
  ModelRef,
  ToolGrant,
  UpdateAgentInput,
  UpdateDepartmentInput,
} from '@superagent/shared';

/*
 * Forms edit a draft; saving sends only what changed. For an agent that matters: any definition field
 * in a save, even unchanged, makes a new version.
 */

export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  model: ModelRef | null;
  tools: ToolGrant[];
  skills: string[];
  mcp: McpGrant[];
}

export function agentDraft(agent: AgentDefinition): AgentDraft {
  return {
    name: agent.name,
    description: agent.current.description,
    instructions: agent.current.instructions,
    model: agent.current.model,
    tools: agent.current.tools,
    skills: agent.current.skills,
    mcp: agent.current.mcp,
  };
}

export const sameModel = (a: ModelRef | null, b: ModelRef | null): boolean =>
  a === b || (a !== null && b !== null && a.provider === b.provider && a.model === b.model);

const toolKey = (grant: ToolGrant) => `${grant.key}|${grant.requireApproval}|${grant.identity ?? ''}`;
export const sameTools = (a: readonly ToolGrant[], b: readonly ToolGrant[]): boolean =>
  sameSet(a.map(toolKey), b.map(toolKey));

export const sameSkills = (a: readonly string[], b: readonly string[]): boolean => sameSet(a, b);

const mcpKey = (grant: McpGrant) =>
  `${grant.server}|${grant.requireApproval}|${grant.tools ? [...grant.tools].sort().join(',') : '*'}`;
export const sameMcp = (a: readonly McpGrant[], b: readonly McpGrant[]): boolean =>
  sameSet(a.map(mcpKey), b.map(mcpKey));

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((item, index) => item === right[index]);
}

/** What saving `draft` over `agent` sends: the changed fields only, text trimmed. */
export function agentChanges(agent: AgentDefinition, draft: AgentDraft): UpdateAgentInput {
  const changes: UpdateAgentInput = {};
  const current = agent.current;
  if (draft.name.trim() !== agent.name) changes.name = draft.name.trim();
  if (draft.description.trim() !== current.description) changes.description = draft.description.trim();
  if (draft.instructions.trim() !== current.instructions) changes.instructions = draft.instructions.trim();
  if (!sameModel(draft.model, current.model)) changes.model = draft.model;
  if (!sameTools(draft.tools, current.tools)) changes.tools = draft.tools;
  if (!sameSkills(draft.skills, current.skills)) changes.skills = draft.skills;
  if (!sameMcp(draft.mcp, current.mcp)) changes.mcp = draft.mcp;
  return changes;
}

/** Whether saving these changes makes a new version (anything but the name does). */
export const makesVersion = (changes: UpdateAgentInput): boolean =>
  Object.keys(changes).some((field) => field !== 'name');

export type AgentDraftErrors = Partial<Record<'name' | 'description' | 'instructions' | 'mcp', string>>;

/** What stops a draft from saving, by field. */
export function agentDraftErrors(draft: AgentDraft, serverNames: (slug: string) => string): AgentDraftErrors {
  const errors: AgentDraftErrors = {};
  if (!draft.name.trim()) errors.name = 'Give it a name.';
  if (!draft.description.trim()) errors.description = 'Say what it does.';
  else if (draft.description.trim().length > 500) errors.description = 'Keep it under 500 characters.';
  if (!draft.instructions.trim()) errors.instructions = 'Tell it how to work.';
  else if (draft.instructions.trim().length > 20_000)
    errors.instructions = 'Keep it under 20,000 characters.';
  const empty = draft.mcp.find((grant) => grant.tools?.length === 0);
  if (empty)
    errors.mcp = `Pick at least one of ${serverNames(empty.server)}’s tools, or give it all of them.`;
  return errors;
}

/** The fields a version changed from the one before it, in words ("instructions", "tools"). */
export function versionChanges(version: AgentVersion, previous: AgentVersion | undefined): string[] {
  if (!previous) return [];
  const changed: string[] = [];
  if (version.description !== previous.description) changed.push('description');
  if (version.instructions !== previous.instructions) changed.push('instructions');
  if (!sameModel(version.model, previous.model)) changed.push('model');
  if (!sameTools(version.tools, previous.tools)) changed.push('tools');
  if (!sameSkills(version.skills, previous.skills)) changed.push('skills');
  if (!sameMcp(version.mcp, previous.mcp)) changed.push('MCP servers');
  return changed;
}

export interface DepartmentDraft {
  name: string;
  description: string;
  autoClose: boolean;
  skills: string[];
  mcp: McpGrant[];
}

export function departmentDraft(department: Department): DepartmentDraft {
  return {
    name: department.name,
    description: department.description,
    autoClose: department.autoClose,
    skills: department.skills,
    mcp: department.mcp,
  };
}

export function departmentChanges(department: Department, draft: DepartmentDraft): UpdateDepartmentInput {
  const changes: UpdateDepartmentInput = {};
  if (draft.name.trim() !== department.name) changes.name = draft.name.trim();
  if (draft.description.trim() !== department.description) changes.description = draft.description.trim();
  if (draft.autoClose !== department.autoClose) changes.autoClose = draft.autoClose;
  if (!sameSkills(draft.skills, department.skills)) changes.skills = draft.skills;
  if (!sameMcp(draft.mcp, department.mcp)) changes.mcp = draft.mcp;
  return changes;
}
