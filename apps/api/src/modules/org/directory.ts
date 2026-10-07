import type { AgentRole, ModelRef, ToolGrant } from '@superagent/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { agentDefinitions, agentVersions, departments } from '../../db/schema';

export interface DepartmentEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  autoClose: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface AgentVersionEntry {
  version: number;
  description: string;
  instructions: string;
  model: ModelRef | null;
  tools: ToolGrant[];
  createdAt: Date;
}

export interface AgentEntry {
  id: string;
  key: string;
  name: string;
  role: AgentRole;
  departmentId: string;
  activeVersion: number;
  current: AgentVersionEntry;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/**
 * In-memory view of the organization, rebuilt after every write. Compiled agents read it per request
 * (team lists, department names), so most edits apply without recompiling.
 */
export class OrgDirectory {
  private departmentsById = new Map<string, DepartmentEntry>();
  private agentsById = new Map<string, AgentEntry>();
  private reloading: Promise<void> = Promise.resolve();

  constructor(private readonly db: Db) {}

  /**
   * Re-reads the organization. Reloads run one after another, each from a fresh snapshot, so when it
   * resolves the directory includes every write committed before the call (callers rely on seeing their own).
   */
  reload(): Promise<void> {
    const next = this.reloading.catch(() => {}).then(() => this.load());
    this.reloading = next;
    return next;
  }

  private async load(): Promise<void> {
    // One snapshot, so agents always match their departments.
    const { departmentRows, agentRows } = await this.db.transaction(
      async (tx) => ({
        departmentRows: await tx.select().from(departments),
        agentRows: await tx
          .select({ agent: agentDefinitions, version: agentVersions })
          .from(agentDefinitions)
          .innerJoin(
            agentVersions,
            and(
              eq(agentVersions.agentId, agentDefinitions.id),
              eq(agentVersions.version, agentDefinitions.activeVersion),
            ),
          ),
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    this.departmentsById = new Map(departmentRows.map((d) => [d.id, { ...d }]));
    this.agentsById = new Map(
      agentRows.map(({ agent, version }) => [
        agent.id,
        {
          id: agent.id,
          key: agent.key,
          name: agent.name,
          role: agent.role,
          departmentId: agent.departmentId,
          activeVersion: agent.activeVersion,
          current: {
            version: version.version,
            description: version.description,
            instructions: version.instructions,
            model: version.model,
            tools: version.tools,
            createdAt: version.createdAt,
          },
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
          archivedAt: agent.archivedAt,
        },
      ]),
    );
  }

  department(id: string): DepartmentEntry | undefined {
    return this.departmentsById.get(id);
  }

  departments(options: { includeArchived?: boolean } = {}): DepartmentEntry[] {
    return [...this.departmentsById.values()]
      .filter((d) => options.includeArchived || !d.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  agent(id: string): AgentEntry | undefined {
    return this.agentsById.get(id);
  }

  agentByKey(key: string): AgentEntry | undefined {
    return [...this.agentsById.values()].find((a) => a.key === key);
  }

  agents(filter: { departmentId?: string; role?: AgentRole; includeArchived?: boolean } = {}): AgentEntry[] {
    return [...this.agentsById.values()]
      .filter((a) => filter.includeArchived || !a.archivedAt)
      .filter((a) => !filter.departmentId || a.departmentId === filter.departmentId)
      .filter((a) => !filter.role || a.role === filter.role)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  leadOf(departmentId: string): AgentEntry | undefined {
    return this.agents({ departmentId, role: 'lead' })[0];
  }

  /** Active specialists of a department: the lead's team. */
  membersOf(departmentId: string): AgentEntry[] {
    return this.agents({ departmentId, role: 'specialist' });
  }

  /** Active agents whose current version references a provider (a deleted provider would break them). */
  agentsUsingProvider(slug: string): AgentEntry[] {
    return this.agents().filter((a) => a.current.model?.provider === slug);
  }
}
