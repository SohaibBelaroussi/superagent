import type { ModelRef } from '@superagent/shared';

/** Prefix of every model id our gateway resolves: sa/<provider-slug>/<model-id>. */
export const GATEWAY_ID = 'sa';

/** Placeholder provider for roles that are not configured yet; the gateway rejects it with a helpful error. */
export const UNCONFIGURED_PROVIDER = 'unconfigured';

/** Mastra model router id for a model reference. Model ids may themselves contain slashes. */
export function routerId(ref: ModelRef): string {
  return `${GATEWAY_ID}/${ref.provider}/${ref.model}`;
}

export function unconfiguredRouterId(role: string): string {
  return `${GATEWAY_ID}/${UNCONFIGURED_PROVIDER}/${role}`;
}

/** Provider slug from a router id, with or without the `sa/` prefix. */
export function providerSlugOf(id: string): string | undefined {
  const parts = id.split('/');
  const slug = parts[0] === GATEWAY_ID ? parts[1] : parts[0];
  return slug || undefined;
}
