import type { IMastraLogger } from '@mastra/core/logger';
import type {
  CreateAgentInput,
  CreateDepartmentInput,
  McpGrant,
  ModelRef,
  ToolGrant,
  UpdateAgentInput,
  UpdateDepartmentInput,
} from '@superagent/shared';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import { type AgentVersionRow, agentDefinitions, agentVersions, departments } from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { Mutex } from '../../util/mutex';
import type { ProviderService } from '../providers/service';
import type { ToolCatalog } from '../tools/catalog';
import type { AgentEntry, DepartmentEntry, OrgDirectory } from './directory';
import type { AgentRuntime } from './runtime';

/** Keys of agents defined in code. Definitions can't take them. */
export const RESERVED_AGENT_KEYS = new Set(['chief', 'scratch', 'provider-test', 'provider-test-tools']);

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** What other modules need to know or say about organization changes. */
export interface OrgHooks {
  /** Why an agent can't be archived right now, if it can't (dispatch knows about its runs). */
  archiveBlocker?: (agent: AgentEntry) => Promise<{ code: string; message: string } | undefined>;
  /** A department was archived (its schedules pause). */
  departmentArchived?: (departmentId: string) => Promise<void>;
  /** Checks what grants refer to elsewhere: browser identities, skills, MCP servers and their tools. */
  checkGrants?: (grants: { tools?: ToolGrant[]; skills?: string[]; mcp?: McpGrant[] }) => Promise<void>;
  /** A department's MCP grants changed: its agents' tools must be rebuilt. */
  departmentChanged?: (departmentId: string) => void;
}

/** Departments and agent definitions: validation, versioning, and keeping the live agents in sync. */
export class OrgService {
  constructor(
    private readonly db: Db,
    readonly directory: OrgDirectory,
    private readonly runtime: AgentRuntime,
    private readonly providers: ProviderService,
    private readonly catalog: ToolCatalog,
    private readonly logger: IMastraLogger,
    /** Shared with settings updates and provider deletion: model references must not race a delete. */
    private readonly configLock: Mutex,
    private readonly hooks: OrgHooks = {},
  ) {}

  // --- departments ---

  getDepartment(id: string): DepartmentEntry {
    const department = this.directory.department(id);
    if (!department) throw new ApiError(404, 'department_not_found', `No department with id ${id}`);
    return department;
  }

  createDepartment(input: CreateDepartmentInput): Promise<DepartmentEntry> {
    return this.configLock.run(() => this.createDepartmentLocked(input));
  }

  private async createDepartmentLocked(input: CreateDepartmentInput): Promise<DepartmentEntry> {
    await this.hooks.checkGrants?.({ skills: input.skills, mcp: input.mcp });
    const id = uuidv7();
    try {
      await this.db.insert(departments).values({ id, ...input });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'department_slug_taken',
          `A department with slug "${input.slug}" already exists`,
        );
      }
      throw error;
    }
    await this.directory.reload();
    this.logger.info('Department created', { departmentId: id, slug: input.slug });
    return this.getDepartment(id);
  }

  updateDepartment(id: string, input: UpdateDepartmentInput): Promise<DepartmentEntry> {
    return this.configLock.run(() => this.updateDepartmentLocked(id, input));
  }

  private async updateDepartmentLocked(id: string, input: UpdateDepartmentInput): Promise<DepartmentEntry> {
    this.activeDepartment(id);
    await this.hooks.checkGrants?.({ skills: input.skills, mcp: input.mcp });
    await this.db
      .update(departments)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(departments.id, id));
    await this.directory.reload();
    if (input.mcp) this.hooks.departmentChanged?.(id);
    return this.getDepartment(id);
  }

  archiveDepartment(id: string): Promise<void> {
    return this.configLock.run(() => this.archiveDepartmentLocked(id));
  }

  private async archiveDepartmentLocked(id: string): Promise<void> {
    this.activeDepartment(id);
    const active = this.directory.agents({ departmentId: id });
    if (active.length > 0) {
      throw new ApiError(
        409,
        'department_has_agents',
        `Archive its agents first: ${active.map((a) => a.key).join(', ')}`,
      );
    }
    await this.db
      .update(departments)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(departments.id, id));
    await this.directory.reload();
    await this.hooks.departmentArchived?.(id);
    this.logger.info('Department archived', { departmentId: id });
  }

  // --- agents ---

  getAgent(id: string): AgentEntry {
    const agent = this.directory.agent(id);
    if (!agent) throw new ApiError(404, 'agent_not_found', `No agent with id ${id}`);
    return agent;
  }

  async versions(id: string): Promise<AgentVersionRow[]> {
    this.getAgent(id);
    return this.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id))
      .orderBy(desc(agentVersions.version));
  }

  createAgent(input: CreateAgentInput): Promise<AgentEntry> {
    return this.configLock.run(() => this.createAgentLocked(input));
  }

  private async createAgentLocked(input: CreateAgentInput): Promise<AgentEntry> {
    if (RESERVED_AGENT_KEYS.has(input.key) || input.key.startsWith('provider-test')) {
      throw new ApiError(400, 'reserved_agent_key', `"${input.key}" is reserved for a built-in agent`);
    }
    this.activeDepartment(input.departmentId);
    if (input.role === 'lead' && this.directory.leadOf(input.departmentId)) {
      throw new ApiError(409, 'lead_exists', 'This department already has a lead');
    }
    await this.assertTools(input.tools);
    await this.hooks.checkGrants?.({ skills: input.skills, mcp: input.mcp });
    this.assertModel(input.model);

    const id = uuidv7();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(agentDefinitions).values({
          id,
          key: input.key,
          name: input.name,
          role: input.role,
          departmentId: input.departmentId,
          activeVersion: 1,
        });
        await tx.insert(agentVersions).values({
          agentId: id,
          version: 1,
          description: input.description,
          instructions: input.instructions,
          model: input.model,
          tools: input.tools,
          skills: input.skills,
          mcp: input.mcp,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const leadTaken = input.role === 'lead' && this.directory.leadOf(input.departmentId);
        throw leadTaken
          ? new ApiError(409, 'lead_exists', 'This department already has a lead')
          : new ApiError(409, 'agent_key_taken', `The key "${input.key}" is already used`);
      }
      throw error;
    }
    return this.refresh(id, 'Agent created');
  }

  updateAgent(id: string, input: UpdateAgentInput): Promise<AgentEntry> {
    return this.configLock.run(() => this.updateAgentLocked(id, input));
  }

  private async updateAgentLocked(id: string, input: UpdateAgentInput): Promise<AgentEntry> {
    const agent = this.activeAgent(id);
    const changesVersion =
      input.description !== undefined ||
      input.instructions !== undefined ||
      input.model !== undefined ||
      input.tools !== undefined ||
      input.skills !== undefined ||
      input.mcp !== undefined;
    if (input.tools) await this.assertTools(input.tools);
    await this.hooks.checkGrants?.({ skills: input.skills, mcp: input.mcp });
    if (input.model !== undefined) this.assertModel(input.model);

    await this.db.transaction(async (tx) => {
      let activeVersion = agent.activeVersion;
      if (changesVersion) {
        const [latest] = await tx
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.agentId, id))
          .orderBy(desc(agentVersions.version))
          .limit(1);
        activeVersion = (latest?.version ?? 0) + 1;
        await tx.insert(agentVersions).values({
          agentId: id,
          version: activeVersion,
          description: input.description ?? agent.current.description,
          instructions: input.instructions ?? agent.current.instructions,
          model: input.model !== undefined ? input.model : agent.current.model,
          tools: input.tools ?? agent.current.tools,
          skills: input.skills ?? agent.current.skills,
          mcp: input.mcp ?? agent.current.mcp,
        });
      }
      await tx
        .update(agentDefinitions)
        .set({ name: input.name ?? agent.name, activeVersion, updatedAt: new Date() })
        .where(eq(agentDefinitions.id, id));
    });
    return this.refresh(id, changesVersion ? 'Agent version created' : 'Agent renamed');
  }

  /** Rollback (or roll forward) to an existing version. */
  activateVersion(id: string, version: number): Promise<AgentEntry> {
    return this.configLock.run(() => this.activateVersionLocked(id, version));
  }

  private async activateVersionLocked(id: string, version: number): Promise<AgentEntry> {
    this.activeAgent(id);
    const [row] = await this.db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, id), eq(agentVersions.version, version)))
      .limit(1);
    if (!row) throw new ApiError(404, 'version_not_found', `Agent has no version ${version}`);
    await this.assertTools(row.tools);
    await this.hooks.checkGrants?.({ skills: row.skills, mcp: row.mcp });
    this.assertModel(row.model);
    await this.db
      .update(agentDefinitions)
      .set({ activeVersion: version, updatedAt: new Date() })
      .where(eq(agentDefinitions.id, id));
    return this.refresh(id, 'Agent version activated');
  }

  /**
   * Takes a plugin's skills and MCP servers away from everyone (its uninstall): departments lose the
   * references, and agents that had them get a new version without them (old versions keep history).
   */
  detachCapabilities(plugin: string, slugs: string[]): Promise<void> {
    return this.configLock.run(async () => {
      const dropSkill = (ref: string) => ref.split('/')[0] === plugin;
      const dropMcp = (grant: McpGrant) => slugs.includes(grant.server);
      for (const department of this.directory.departments({ includeArchived: true })) {
        if (!department.skills.some(dropSkill) && !department.mcp.some(dropMcp)) continue;
        await this.db
          .update(departments)
          .set({
            skills: department.skills.filter((ref) => !dropSkill(ref)),
            mcp: department.mcp.filter((grant) => !dropMcp(grant)),
            updatedAt: new Date(),
          })
          .where(eq(departments.id, department.id));
      }
      await this.directory.reload();
      for (const agent of this.directory.agents()) {
        if (!agent.current.skills.some(dropSkill) && !agent.current.mcp.some(dropMcp)) continue;
        await this.updateAgentLocked(agent.id, {
          skills: agent.current.skills.filter((ref) => !dropSkill(ref)),
          mcp: agent.current.mcp.filter((grant) => !dropMcp(grant)),
        });
      }
      // Agents of departments that lost MCP grants get rebuilt without those tools.
      for (const agent of this.directory.agents()) this.runtime.upsert(agent);
    });
  }

  archiveAgent(id: string): Promise<void> {
    return this.configLock.run(() => this.archiveAgentLocked(id));
  }

  private async archiveAgentLocked(id: string): Promise<void> {
    const agent = this.activeAgent(id);
    // Deciding a call needs its agent: once archived, a call it waits on could never be decided.
    const blocker = await this.hooks.archiveBlocker?.(agent);
    if (blocker) throw new ApiError(409, blocker.code, blocker.message);
    await this.db
      .update(agentDefinitions)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentDefinitions.id, id));
    await this.directory.reload();
    this.runtime.remove(agent.key);
    this.logger.info('Agent archived', { agentId: id, key: agent.key });
  }

  // --- helpers ---

  private async refresh(id: string, message: string): Promise<AgentEntry> {
    await this.directory.reload();
    const entry = this.getAgent(id);
    // Never bring an archived agent back to life, whatever raced with the archive.
    if (entry.archivedAt) this.runtime.remove(entry.key);
    else this.runtime.upsert(entry);
    this.logger.info(message, { agentId: id, key: entry.key, version: entry.activeVersion });
    return entry;
  }

  private activeDepartment(id: string): DepartmentEntry {
    const department = this.getDepartment(id);
    if (department.archivedAt) throw new ApiError(409, 'department_archived', 'This department is archived');
    return department;
  }

  private activeAgent(id: string): AgentEntry {
    const agent = this.getAgent(id);
    if (agent.archivedAt) throw new ApiError(409, 'agent_archived', 'This agent is archived');
    return agent;
  }

  private async assertTools(grants: ToolGrant[]): Promise<void> {
    const seen = new Set<string>();
    for (const grant of grants) {
      if (!this.catalog.has(grant.key)) {
        throw new ApiError(
          400,
          'unknown_tool',
          `No tool "${grant.key}" in the catalog (GET /v1/catalog/tools)`,
        );
      }
      if (seen.has(grant.key))
        throw new ApiError(400, 'duplicate_tool', `Tool "${grant.key}" is listed twice`);
      if (grant.identity && !this.catalog.takesIdentity(grant.key)) {
        throw new ApiError(400, 'identity_not_applicable', `Only the browser grant takes an identity`);
      }
      seen.add(grant.key);
    }
    await this.hooks.checkGrants?.({ tools: grants });
  }

  private assertModel(model: ModelRef | null): void {
    if (model) this.providers.assertUsable(model, 'model', 'chat');
  }
}
