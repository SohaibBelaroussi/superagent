import type { AgentDefinition, Department } from '@superagent/shared';
import { useMemo } from 'react';
import { useAgents, useDepartments } from '../../api/queries';

export interface OrgLookup {
  department(id: string): Department | undefined;
  departmentBySlug(slug: string): Department | undefined;
  agent(id: string | null): AgentDefinition | undefined;
  /** An agent by its key ("research-lead"): events name agents by key. */
  agentByKey(key: string): AgentDefinition | undefined;
  departments: Department[];
  ready: boolean;
}

/** Departments and agents by id, slug and key: tasks and events refer to them every way. */
export function useOrg(): OrgLookup {
  const departments = useDepartments();
  const agents = useAgents();
  return useMemo(() => {
    const byId = new Map((departments.data ?? []).map((department) => [department.id, department]));
    const bySlug = new Map((departments.data ?? []).map((department) => [department.slug, department]));
    const agentById = new Map((agents.data ?? []).map((agent) => [agent.id, agent]));
    const agentByKey = new Map((agents.data ?? []).map((agent) => [agent.key, agent]));
    return {
      department: (id) => byId.get(id),
      departmentBySlug: (slug) => bySlug.get(slug),
      agent: (id) => (id ? agentById.get(id) : undefined),
      agentByKey: (key) => agentByKey.get(key),
      departments: (departments.data ?? []).filter((department) => !department.archivedAt),
      ready: departments.isSuccess && agents.isSuccess,
    };
  }, [departments.data, departments.isSuccess, agents.data, agents.isSuccess]);
}
