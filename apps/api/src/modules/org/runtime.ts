import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import type { McpService } from '../capabilities/mcp/service';
import type { SkillStore } from '../capabilities/skills';
import {
  DepartmentNotesProcessor,
  type MemoryProfiles,
  type OwnerProfileProcessor,
} from '../memory/profiles';
import type { MemoryService } from '../memory/service';
import { routerId } from '../providers/model-ref';
import type { SettingsService } from '../settings/service';
import type { ToolCatalog } from '../tools/catalog';
import { shareTaskOnDelegation, type WorkspaceService } from '../workspace/service';
import type { AgentEntry, OrgDirectory } from './directory';
import { leadInstructions, specialistInstructions } from './instructions';

const MAX_STEPS = { lead: 12, specialist: 8 } as const;

export interface CompileDeps {
  mastra: Mastra;
  directory: OrgDirectory;
  settings: SettingsService;
  catalog: ToolCatalog;
  /** Memory by profile: leads keep department notes, specialists only short history. */
  memory: MemoryProfiles;
  /** Adds the owner's profile to every department agent's context. */
  ownerProfile: OwnerProfileProcessor;
  /** Leads read their department's notes from it. */
  memoryService: MemoryService;
  /** Ledger tools every lead gets (update_task, report_to_chief, ...). */
  leadTools: ToolsInput;
  /** Task workspaces for agents granted files or shell. */
  workspaces: WorkspaceService;
  /** MCP servers' tools for agents granted them (decision D36). */
  mcp: McpService;
  /** Skills for agents and departments they are attached to (decision D37). */
  skills: SkillStore;
}

/** Turns one definition (its active version) into a Mastra agent. */
export function compileAgent(entry: AgentEntry, deps: CompileDeps): Agent {
  const {
    directory,
    settings,
    catalog,
    mastra,
    memory,
    leadTools,
    ownerProfile,
    memoryService,
    workspaces,
    mcp,
    skills,
  } = deps;
  // MCP tools are fixed per compile (the runtime rebuilds agents when they change); skills are looked
  // up per request, so attaching one applies on the next run.
  const mcpTools = mcp.toolsFor(directory.mcpOf(entry));
  const model = entry.current.model;
  return new Agent({
    id: entry.key,
    name: entry.name,
    description: entry.current.description,
    // Per request: team and department changes apply without recompiling. Falls back to the
    // compiled snapshot if the definition disappeared from the directory mid-flight.
    instructions: () => {
      const fresh = directory.agent(entry.id) ?? entry;
      return fresh.role === 'lead'
        ? leadInstructions(fresh, directory)
        : specialistInstructions(fresh, directory);
    },
    model: model ? routerId(model) : () => settings.modelRouterId('default'),
    tools:
      entry.role === 'lead'
        ? { ...catalog.build(entry.current.tools), ...mcpTools, ...leadTools }
        : { ...catalog.build(entry.current.tools), ...mcpTools },
    memory: entry.role === 'lead' ? memory.lead : memory.specialist,
    // Inside a task only: the task's folder and sandbox (decision D33).
    workspace: workspaces.workspaceFor(entry.key, entry.current.tools, {
      source: skills.source,
      paths: () => skills.pathsFor(directory.skillsOf(directory.agent(entry.id) ?? entry)),
    }),
    inputProcessors:
      entry.role === 'lead'
        ? [ownerProfile, new DepartmentNotesProcessor(memoryService, entry.departmentId)]
        : [ownerProfile],
    // A lead's team is its department's active specialists, looked up per request so new or
    // edited specialists are picked up immediately. The agents function receives no mastra handle.
    agents:
      entry.role === 'lead'
        ? () => {
            const team: Record<string, Agent> = {};
            for (const member of directory.membersOf(entry.departmentId)) {
              const agent = registeredAgent(mastra, member.key);
              if (agent) team[member.key] = agent;
            }
            return team;
          }
        : undefined,
    defaultOptions: {
      maxSteps: MAX_STEPS[entry.role],
      // Specialists get only the lead's delegation prompt, not the lead's system prompt and history,
      // and the lead's task, so they work in its sandbox.
      delegation: {
        messageFilter: () => [],
        ...(entry.role === 'lead' ? { onDelegationStart: shareTaskOnDelegation } : {}),
      },
    },
  });
}

function registeredAgent(mastra: Mastra, key: string): Agent | undefined {
  try {
    return mastra.getAgent(key) as Agent;
  } catch {
    return undefined;
  }
}

/** Keeps Mastra's agent registry in sync with the directory. */
export class AgentRuntime {
  constructor(
    private readonly deps: CompileDeps,
    private readonly logger: IMastraLogger,
  ) {}

  /** Registers every active definition. Order doesn't matter: teams are resolved lazily. */
  loadAll(): void {
    for (const entry of this.deps.directory.agents()) this.upsert(entry);
  }

  /**
   * Compiles first, then swaps without an await in between, so the id never goes missing.
   * `addAgent` silently ignores an existing key, hence the explicit remove and the check.
   */
  upsert(entry: AgentEntry): void {
    const next = compileAgent(entry, this.deps);
    this.deps.mastra.removeAgent(entry.key);
    this.deps.mastra.addAgent(next, entry.key);
    if (registeredAgent(this.deps.mastra, entry.key) !== next) {
      throw new Error(`Agent "${entry.key}" could not be registered`);
    }
    this.logger.debug('Agent compiled', { key: entry.key, version: entry.activeVersion });
  }

  /** Rebuilds the agents that get tools from these MCP servers (their tools changed). */
  recompileGranting(slugs: string[]): void {
    const changed = new Set(slugs);
    for (const agent of this.deps.directory.agents()) {
      if (this.deps.directory.mcpOf(agent).some((grant) => changed.has(grant.server))) this.upsert(agent);
    }
  }

  /** Rebuilds a department's agents (its MCP grants changed). */
  recompileDepartment(departmentId: string): void {
    for (const agent of this.deps.directory.agents({ departmentId })) this.upsert(agent);
  }

  remove(key: string): void {
    this.deps.mastra.removeAgent(key);
    this.logger.debug('Agent removed', { key });
  }
}
