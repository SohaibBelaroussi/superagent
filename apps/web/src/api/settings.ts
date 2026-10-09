import { api, apiVoid, queryKeys } from '@superagent/client';
import {
  type AddModelInput,
  CreatedTokenSchema,
  type CreateMcpServerInput,
  type CreateProviderInputSchema,
  type InstallPluginInput,
  McpServerListSchema,
  McpServerSchema,
  PairingCodeSchema,
  PluginListSchema,
  PluginPreviewSchema,
  PluginSchema,
  type PreviewPluginInput,
  ProviderListSchema,
  ProviderModelListSchema,
  ProviderSchema,
  type ProviderTestInput,
  ProviderTestResultSchema,
  type PutSecretInput,
  SecretListSchema,
  SecretSchema,
  type SetModelPriceInput,
  SettingsSchema,
  SkillListSchema,
  SkillSchema,
  TokenListSchema,
  type UpdateMcpServerInput,
  type UpdateProviderInput,
  type UpdateSettingsInput,
} from '@superagent/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

/*
 * Settings: providers and their models, model roles and limits, devices, secrets, MCP servers, plugins
 * and skills. A change to what agents can be given also refreshes the capabilities the organization's
 * forms list.
 */

const providerPath = (id: string, rest = '') => `/v1/providers/${encodeURIComponent(id)}${rest}`;

/**
 * For mutations that carry a credential (a key, a token, a secret's value): dropped from the cache as
 * soon as nothing shows them, not kept for the default five minutes.
 */
const FORGET = { gcTime: 0 } as const;

/** While something is still starting: how often to look again (no live event covers it). */
const SETTLING_MS = 3_000;

export const settingsKeys = {
  providerModels: queryKeys.providerModels,
  tokens: ['tokens'] as const,
  secrets: ['secrets'] as const,
  mcpServers: ['mcp-servers'] as const,
  plugins: ['plugins'] as const,
  skills: ['skills'] as const,
  skill: (id: string) => ['skills', id] as const,
};

/** Every provider, enabled or not (the model pickers use the enabled ones). */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api(ProviderListSchema, '/v1/providers', { signal }),
    select: (data) => data.items,
  });
}

export function useProviderModels(id: string) {
  return useQuery({
    queryKey: queryKeys.providerModels(id),
    queryFn: ({ signal }) => api(ProviderModelListSchema, providerPath(id, '/models'), { signal }),
    select: (data) => data.items,
  });
}

/** After a change to a provider: the list (not each one's models, which it doesn't change) and the roles. */
function refreshProviders(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.providers, exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
}

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateProviderInputSchema>) =>
      api(ProviderSchema, '/v1/providers', { method: 'POST', json: input }),
    onSuccess: () => refreshProviders(queryClient),
    meta: { silent: true },
    ...FORGET,
  });
}

export function useUpdateProvider(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProviderInput) =>
      api(ProviderSchema, providerPath(id), { method: 'PATCH', json: input }),
    onSuccess: () => refreshProviders(queryClient),
    meta: { silent: true },
    ...FORGET,
  });
}

export function useDeleteProvider(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiVoid(providerPath(id), { method: 'DELETE' }),
    onSuccess: () => {
      // Gone from the list at once; its models' query is left to expire, never asked for again.
      queryClient.setQueryData<z.infer<typeof ProviderListSchema>>(
        queryKeys.providers,
        (list) => list && { items: list.items.filter((provider) => provider.id !== id) },
      );
      refreshProviders(queryClient);
    },
    meta: { failure: 'Couldn’t delete the provider' },
  });
}

/** The models list a model mutation answers with, put straight into its query. */
function useModelsMutation<T>(
  id: string,
  run: (input: T) => Promise<{ items: unknown[] }>,
  meta: { failure?: string; silent?: boolean },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (list) => queryClient.setQueryData(queryKeys.providerModels(id), list),
    meta,
  });
}

/**
 * Asks a provider for its models again (`GET {baseUrl}/models`), by id: also for one just added,
 * whose own hooks don't exist yet. Callers say how it went.
 */
export function useDiscoverModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(ProviderModelListSchema, providerPath(id, '/refresh-models'), { method: 'POST' }),
    onSuccess: (list, id) => queryClient.setQueryData(queryKeys.providerModels(id), list),
    meta: { silent: true },
  });
}

export function useAddModel(id: string) {
  return useModelsMutation(
    id,
    (input: AddModelInput) =>
      api(ProviderModelListSchema, providerPath(id, '/models'), { method: 'POST', json: input }),
    { failure: 'Couldn’t add the model' },
  );
}

export function useRemoveModel(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) =>
      apiVoid(providerPath(id, '/models'), { method: 'DELETE', query: { modelId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.providerModels(id) }),
    meta: { failure: 'Couldn’t remove the model' },
  });
}

export function useSetPrice(id: string) {
  return useModelsMutation(
    id,
    (input: SetModelPriceInput) =>
      api(ProviderModelListSchema, providerPath(id, '/prices'), { method: 'PUT', json: input }),
    // The price dialog says why.
    { silent: true },
  );
}

export function useRemovePrice(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) =>
      apiVoid(providerPath(id, '/prices'), { method: 'DELETE', query: { modelId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.providerModels(id) }),
    meta: { failure: 'Couldn’t remove the price' },
  });
}

/** Plain chat, streaming, tool calls and (optionally) embeddings against the provider. */
export function useTestProvider(id: string) {
  return useMutation({
    mutationFn: (input: ProviderTestInput) =>
      api(ProviderTestResultSchema, providerPath(id, '/test'), { method: 'POST', json: input }),
    meta: { failure: 'Couldn’t run the checks' },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) =>
      api(SettingsSchema, '/v1/settings', { method: 'PATCH', json: input }),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // The attention inbox says when a model role is missing.
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
      // Usage is grouped into days in the timezone.
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    },
    meta: { silent: true },
  });
}

/**
 * The API tokens, with the admin token (D45: asked for on the page, kept in memory only). Nothing is
 * asked for until there is one. Each token given is a new `attempt`, asked afresh: nothing is kept
 * from the one before (its refusal, or the list it read).
 */
/** The tokens, read with the admin token. `pollMs`: look again that often (a phone pairing meanwhile). */
export function useTokens(adminToken: string | null, attempt: number, pollMs?: number) {
  return useQuery({
    queryKey: [...settingsKeys.tokens, attempt],
    queryFn: ({ signal }) => api(TokenListSchema, '/v1/tokens', { signal, token: adminToken ?? undefined }),
    select: (data) => data.items,
    enabled: Boolean(adminToken),
    refetchInterval: pollMs,
    retry: false,
    // Dropped as soon as nothing shows it: the list was read with a token this page doesn't keep.
    gcTime: 0,
  });
}

export function useCreateToken(adminToken: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api(CreatedTokenSchema, '/v1/tokens', {
        method: 'POST',
        json: { name },
        token: adminToken ?? undefined,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens }),
    meta: { failure: 'Couldn’t create the token' },
    ...FORGET,
  });
}

/** A pairing code for a phone (D53), made with the admin token: it claims one device token, once. */
export function useCreatePairing(adminToken: string | null) {
  return useMutation({
    mutationFn: () =>
      api(PairingCodeSchema, '/v1/tokens/pairing', { method: 'POST', token: adminToken ?? undefined }),
    meta: { failure: 'Couldn’t make a pairing code' },
    ...FORGET,
  });
}

/** Ends the codes nobody claimed, so one seen on the screen stops working when the dialog closes. */
export function useWithdrawPairing(adminToken: string | null) {
  return useMutation({
    mutationFn: () => apiVoid('/v1/tokens/pairing', { method: 'DELETE', token: adminToken ?? undefined }),
    meta: { failure: 'Couldn’t withdraw the pairing code' },
    ...FORGET,
  });
}

export function useRevokeToken(adminToken: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiVoid(`/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', token: adminToken ?? undefined }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens }),
    meta: { failure: 'Couldn’t revoke the token' },
    ...FORGET,
  });
}

export function useSecrets() {
  return useQuery({
    queryKey: settingsKeys.secrets,
    queryFn: ({ signal }) => api(SecretListSchema, '/v1/secrets', { signal }),
    select: (data) => data.items,
  });
}

/** Stores a secret's value (sealed; it never comes back), creating or replacing it. */
export function usePutSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, ...input }: PutSecretInput & { name: string }) =>
      api(SecretSchema, `/v1/secrets/${encodeURIComponent(name)}`, { method: 'PUT', json: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.secrets }),
    meta: { silent: true },
    ...FORGET,
  });
}

export function useDeleteSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiVoid(`/v1/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.secrets }),
    meta: { failure: 'Couldn’t delete the secret' },
  });
}

/** After a change to what agents can be given: the lists here and the organization's forms. */
function refreshCapabilities(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: settingsKeys.mcpServers });
  void queryClient.invalidateQueries({ queryKey: settingsKeys.plugins });
  void queryClient.invalidateQueries({ queryKey: settingsKeys.skills });
  void queryClient.invalidateQueries({ queryKey: settingsKeys.secrets });
  void queryClient.invalidateQueries({ queryKey: queryKeys.capabilities });
}

export function useMcpServers() {
  return useQuery({
    queryKey: settingsKeys.mcpServers,
    queryFn: ({ signal }) => api(McpServerListSchema, '/v1/mcp-servers', { signal }),
    select: (data) => data.items,
    // A server still starting is looked at again until it is ready or failed.
    refetchInterval: (query) =>
      query.state.data?.items.some((server) => server.enabled && server.status === 'pending')
        ? SETTLING_MS
        : false,
  });
}

/** A server as the API answered for it, put in the list at once. */
function putServer(queryClient: QueryClient, server: z.infer<typeof McpServerSchema>): void {
  queryClient.setQueryData<z.infer<typeof McpServerListSchema>>(
    settingsKeys.mcpServers,
    (list) => list && { items: list.items.map((item) => (item.id === server.id ? server : item)) },
  );
}

export function useCreateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMcpServerInput) =>
      api(McpServerSchema, '/v1/mcp-servers', { method: 'POST', json: input }),
    onSuccess: () => refreshCapabilities(queryClient),
    meta: { silent: true },
    // Its headers may hold a credential given as a plain value.
    ...FORGET,
  });
}

export function useUpdateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMcpServerInput & { id: string }) =>
      api(McpServerSchema, `/v1/mcp-servers/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: (server) => {
      putServer(queryClient, server);
      refreshCapabilities(queryClient);
    },
    meta: { silent: true },
    ...FORGET,
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(`/v1/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => refreshCapabilities(queryClient),
    meta: { failure: 'Couldn’t delete the server' },
  });
}

/** Lists a server's tools again. */
export function useRefreshMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(McpServerSchema, `/v1/mcp-servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    onSuccess: (server) => {
      putServer(queryClient, server);
      refreshCapabilities(queryClient);
    },
    meta: { failure: 'Couldn’t reach the server' },
  });
}

export function usePlugins() {
  return useQuery({
    queryKey: settingsKeys.plugins,
    queryFn: ({ signal }) => api(PluginListSchema, '/v1/plugins', { signal }),
    select: (data) => data.items,
    // A plugin still installing (its servers starting) is looked at again until it is done.
    refetchInterval: (query) =>
      query.state.data?.items.some((plugin) => plugin.status === 'installing') ? SETTLING_MS : false,
  });
}

/** Fetches a plugin (pinned) and says what it would install, without installing it. */
export function usePreviewPlugin() {
  return useMutation({
    mutationFn: (input: PreviewPluginInput) =>
      api(PluginPreviewSchema, '/v1/plugins/preview', { method: 'POST', json: input }),
    meta: { silent: true },
  });
}

export function useInstallPlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InstallPluginInput) =>
      api(PluginSchema, '/v1/plugins', { method: 'POST', json: input }),
    onSuccess: () => refreshCapabilities(queryClient),
    meta: { silent: true },
    // The values it needs may be credentials.
    ...FORGET,
  });
}

export function useUninstallPlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(`/v1/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refreshCapabilities(queryClient);
      // Its skills and servers leave agents' and departments' grants.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
    },
    meta: { failure: 'Couldn’t uninstall the plugin' },
  });
}

export function useSkills() {
  return useQuery({
    queryKey: settingsKeys.skills,
    queryFn: ({ signal }) => api(SkillListSchema, '/v1/skills', { signal }),
    select: (data) => data.items,
  });
}

/** One skill with its files (only when asked for). */
export function useSkill(id: string | null) {
  return useQuery({
    queryKey: settingsKeys.skill(id ?? ''),
    queryFn: ({ signal }) => api(SkillSchema, `/v1/skills/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}
