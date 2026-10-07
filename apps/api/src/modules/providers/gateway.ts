import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  MastraModelGateway,
  type ProviderConfig,
} from '@mastra/core/llm';
import { GATEWAY_ID, providerSlugOf, UNCONFIGURED_PROVIDER } from './model-ref';
import type { ProviderRegistry, ResolvedProvider } from './registry';

/** AI SDK chat model for a provider. includeUsage makes streaming report token counts. */
export function buildChatModel(provider: ResolvedProvider, modelId: string): GatewayLanguageModel {
  return createOpenAICompatible({
    name: provider.slug,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    headers: provider.headers,
    includeUsage: true,
    supportsStructuredOutputs: provider.strictJson,
  }).chatModel(modelId);
}

/**
 * Resolves `sa/<provider-slug>/<model-id>` against the providers table (via the in-memory registry)
 * on every request, so adding a provider, editing its URL or rotating its key needs no restart.
 */
export class ProviderGateway extends MastraModelGateway {
  readonly id = GATEWAY_ID;
  readonly name = 'superagent providers';

  constructor(private readonly registry: ProviderRegistry) {
    super();
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return Object.fromEntries(
      this.registry
        .list()
        .filter((p) => p.enabled)
        .map((p) => [
          p.slug,
          {
            name: p.name,
            url: p.baseUrl,
            apiKeyEnvVar: [],
            gateway: GATEWAY_ID,
            models: p.models.filter((m) => m.enabled && m.kind === 'chat').map((m) => m.modelId),
          },
        ]),
    );
  }

  buildUrl(modelId: string): string | undefined {
    const slug = providerSlugOf(modelId);
    return slug ? this.registry.get(slug)?.baseUrl : undefined;
  }

  async getApiKey(): Promise<string> {
    return '';
  }

  resolveAuth(request: GatewayAuthRequest): GatewayAuthResult | undefined {
    const provider = this.registry.get(request.providerId);
    return provider ? { apiKey: provider.apiKey ?? '', source: 'gateway' } : undefined;
  }

  resolveLanguageModel(args: { modelId: string; providerId: string }): GatewayLanguageModel {
    if (args.providerId === UNCONFIGURED_PROVIDER) {
      throw new Error(
        `No model is configured for the "${args.modelId}" role. ` +
          'Set it with PATCH /v1/settings { "models": { "<role>": { "provider": "<slug>", "model": "<id>" } } }.',
      );
    }
    const provider = this.registry.get(args.providerId);
    if (!provider) throw new Error(`Unknown model provider "${args.providerId}"`);
    if (!provider.enabled) throw new Error(`Model provider "${args.providerId}" is disabled`);
    return buildChatModel(provider, args.modelId);
  }
}
