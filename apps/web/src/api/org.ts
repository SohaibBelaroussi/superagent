import {
  type AgentDefinition,
  AgentDefinitionSchema,
  AgentVersionListSchema,
  BrowserIdentityListSchema,
  CapabilitiesSchema,
  type CreateAgentInputSchema,
  type CreateDepartmentInputSchema,
  type Department,
  DepartmentSchema,
  type ModelRef,
  ProviderListSchema,
  ProviderModelListSchema,
  SettingsSchema,
  type UpdateAgentInput,
  type UpdateDepartmentInput,
} from '@superagent/shared';
import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { api, apiVoid } from './client';
import { queryKeys } from './queries';

/*
 * The organization: departments, agents and their versions, and what agents can be given (tools,
 * skills, MCP servers, browser identities, models). Every write refreshes both lists, since a
 * department shows its lead and specialists and an agent names its department.
 */

const departmentPath = (id: string, rest = '') => `/v1/departments/${encodeURIComponent(id)}${rest}`;
const agentPath = (id: string, rest = '') => `/v1/agents/${encodeURIComponent(id)}${rest}`;

function refreshOrg(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
  void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
}

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateDepartmentInputSchema>) =>
      api(DepartmentSchema, '/v1/departments', { method: 'POST', json: input }),
    onSuccess: (department) => {
      setDepartment(queryClient, department);
      refreshOrg(queryClient);
    },
    meta: { silent: true },
  });
}

export function useUpdateDepartment(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDepartmentInput) =>
      api(DepartmentSchema, departmentPath(id), { method: 'PATCH', json: input }),
    onSuccess: (department) => {
      setDepartment(queryClient, department);
      refreshOrg(queryClient);
    },
    meta: { silent: true },
  });
}

export function useArchiveDepartment(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiVoid(departmentPath(id), { method: 'DELETE' }),
    onSuccess: () => refreshOrg(queryClient),
    meta: { failure: 'Couldn’t archive the department' },
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateAgentInputSchema>) =>
      api(AgentDefinitionSchema, '/v1/agents', { method: 'POST', json: input }),
    onSuccess: (agent) => {
      setAgent(queryClient, agent);
      refreshOrg(queryClient);
    },
    meta: { silent: true },
  });
}

/**
 * Saves an agent. Send only what changed: any of its definition's fields, even unchanged, makes a new
 * version.
 */
export function useUpdateAgent(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentInput) =>
      api(AgentDefinitionSchema, agentPath(id), { method: 'PATCH', json: input }),
    onSuccess: (agent) => {
      setAgent(queryClient, agent);
      refreshOrg(queryClient);
    },
    meta: { silent: true },
  });
}

export function useArchiveAgent(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiVoid(agentPath(id), { method: 'DELETE' }),
    onSuccess: () => refreshOrg(queryClient),
    meta: { failure: 'Couldn’t archive the agent' },
  });
}

/** An agent's versions, newest first. */
export function useAgentVersions(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agentVersions(id ?? ''),
    queryFn: ({ signal }) => api(AgentVersionListSchema, agentPath(id ?? '', '/versions'), { signal }),
    select: (data) => data.items,
    enabled: Boolean(id),
  });
}

/** Puts the agent back on an earlier version (or forward on a later one). */
export function useActivateVersion(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api(AgentDefinitionSchema, agentPath(id, `/versions/${version}/activate`), { method: 'POST' }),
    onSuccess: (agent) => {
      setAgent(queryClient, agent);
      refreshOrg(queryClient);
    },
    meta: { failure: 'Couldn’t switch versions' },
  });
}

/**
 * The list with this item put in (replaced, or added when new), so the page shows it at once: a page
 * opened right after making something finds it, and a save shows saved. The refetch after brings the
 * rest (a department's lead and members).
 */
function putInList<T extends { id: string }>(
  queryClient: QueryClient,
  key: readonly string[],
  item: T,
): void {
  queryClient.setQueryData<{ items: T[] }>(key, (list) =>
    list
      ? {
          items: list.items.some((entry) => entry.id === item.id)
            ? list.items.map((entry) => (entry.id === item.id ? item : entry))
            : [...list.items, item],
        }
      : list,
  );
}

const setAgent = (queryClient: QueryClient, agent: AgentDefinition) =>
  putInList(queryClient, queryKeys.agents, agent);
const setDepartment = (queryClient: QueryClient, department: Department) =>
  putInList(queryClient, queryKeys.departments, department);

/** What agents and departments can be given: catalog tools, skills, MCP servers and their tools. */
export function useCapabilities() {
  return useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: ({ signal }) => api(CapabilitiesSchema, '/v1/capabilities', { signal }),
    staleTime: 60_000,
  });
}

/** Signed-in browser profiles a browser grant can use. */
export function useBrowserIdentities(enabled = true) {
  return useQuery({
    queryKey: queryKeys.identities,
    queryFn: ({ signal }) => api(BrowserIdentityListSchema, '/v1/browser-identities', { signal }),
    select: (data) => data.items,
    enabled,
    staleTime: 60_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api(SettingsSchema, '/v1/settings', { signal }),
    staleTime: 5 * 60_000,
  });
}

export interface ModelChoice {
  ref: ModelRef;
  /** "Provider name · model-id". */
  label: string;
}

/** The chat models agents can use: every enabled model of every enabled provider. */
export function useModelChoices() {
  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api(ProviderListSchema, '/v1/providers', { signal }),
    select: (data) => data.items.filter((provider) => provider.enabled),
    staleTime: 5 * 60_000,
  });
  return useQueries({
    queries: (providers.data ?? []).map((provider) => ({
      queryKey: queryKeys.providerModels(provider.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(ProviderModelListSchema, `/v1/providers/${encodeURIComponent(provider.id)}/models`, { signal }),
      staleTime: 5 * 60_000,
    })),
    combine: (results) => ({
      pending: providers.isPending || results.some((result) => result.isPending),
      choices: results.flatMap((result, index): ModelChoice[] => {
        const provider = providers.data?.[index];
        if (!provider || !result.data) return [];
        return result.data.items
          .filter((model) => model.kind === 'chat' && model.enabled)
          .map((model) => ({
            ref: { provider: provider.slug, model: model.modelId },
            label: `${provider.name} · ${model.modelId}`,
          }));
      }),
    }),
  });
}

/** A department's agents: its lead first, then its specialists by name; archived ones apart. */
export function teamOf(department: Department, agents: readonly AgentDefinition[]) {
  const mine = agents.filter((agent) => agent.departmentId === department.id);
  const byName = (a: AgentDefinition, b: AgentDefinition) => a.name.localeCompare(b.name);
  const active = mine.filter((agent) => !agent.archivedAt);
  return {
    lead: active.find((agent) => agent.role === 'lead'),
    specialists: active.filter((agent) => agent.role === 'specialist').sort(byName),
    archived: mine.filter((agent) => agent.archivedAt).sort(byName),
  };
}
