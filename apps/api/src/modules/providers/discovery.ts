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

/** Accepts the OpenAI shape (`{ data: [{ id }] }`) and the common variants other servers return. */
export function parseModelList(body: unknown): DiscoveredModel[] {
  const container = body as { data?: unknown; models?: unknown } | null;
  const list: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : [];
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

/** Lists a provider's models via `GET {baseUrl}/models`. */
export async function discoverModels(target: {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
}): Promise<DiscoveredModel[]> {
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}/models`, {
      headers: {
        accept: 'application/json',
        ...target.headers,
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new DiscoveryError(`Could not reach ${target.baseUrl}/models: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new DiscoveryError(
      `GET ${target.baseUrl}/models returned ${response.status} ${response.statusText}`,
    );
  }
  return parseModelList(await response.json().catch(() => null));
}
