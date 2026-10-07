import type { ModelKind } from '@superagent/shared';

export interface DiscoveredModel {
  modelId: string;
  kind: ModelKind;
}

export class DiscoveryError extends Error {
  override name = 'DiscoveryError';
}

/** Best guess from the model id; users can add or correct models by hand. */
export function guessModelKind(modelId: string): ModelKind {
  return /embed/i.test(modelId) ? 'embedding' : 'chat';
}

/**
 * Accepts the OpenAI shape (`{ data: [{ id }] }`) and the common variants other servers return.
 * Returns null when the body has no recognizable model list (a login page, an error object).
 */
export function parseModelList(body: unknown): DiscoveredModel[] | null {
  const container = body as { data?: unknown; models?: unknown } | null;
  const list: unknown[] | null = Array.isArray(body)
    ? body
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : null;
  if (!list) return null;
  const ids = new Set<string>();
  for (const entry of list) {
    const id =
      typeof entry === 'string'
        ? entry
        : ((entry as { id?: unknown; name?: unknown; model?: unknown } | null)?.id ??
          (entry as { name?: unknown })?.name ??
          (entry as { model?: unknown })?.model);
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  return [...ids].map((modelId) => ({ modelId, kind: guessModelKind(modelId) }));
}

/**
 * Lists a provider's models via `GET {baseUrl}/models`. Anything that isn't a non-empty model list
 * (an HTML login page, unknown JSON, a body cut off by the timeout) is an error, never "no models",
 * so a bad response can't wipe the models we already know.
 */
export async function discoverModels(target: {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
}): Promise<DiscoveredModel[]> {
  const endpoint = `${target.baseUrl}/models`;
  let body: unknown;
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        ...target.headers,
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new DiscoveryError(`GET ${endpoint} returned ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new DiscoveryError(
        `GET ${endpoint} did not return JSON. Check the base URL (it usually ends in /v1).`,
      );
    }
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(`Could not reach ${endpoint}: ${(error as Error).message}`);
  }
  const models = parseModelList(body);
  if (!models) throw new DiscoveryError(`GET ${endpoint} returned JSON without a model list`);
  if (models.length === 0) throw new DiscoveryError(`GET ${endpoint} listed no models`);
  return models;
}
