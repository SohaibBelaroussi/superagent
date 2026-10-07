import type { IMastraLogger } from '@mastra/core/logger';
import type { AddModelInput, CreateProviderInput, ModelRef, UpdateProviderInput } from '@superagent/shared';
import { and, eq, notInArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { SecretBox } from '../../crypto/secret-box';
import type { Db } from '../../db/client';
import { providerModels, providers } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { DiscoveryError, discoverModels } from './discovery';
import { type ProviderRegistry, type ResolvedModel, type ResolvedProvider, secretContext } from './registry';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** Provider management: CRUD with sealed secrets, model discovery and manual models. */
export class ProviderService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    readonly registry: ProviderRegistry,
    private readonly logger: IMastraLogger,
  ) {}

  list(): ResolvedProvider[] {
    return this.registry.list();
  }

  get(id: string): ResolvedProvider {
    const provider = this.registry.getById(id);
    if (!provider) throw new ApiError(404, 'provider_not_found', `No provider with id ${id}`);
    return provider;
  }

  async create(input: CreateProviderInput): Promise<ResolvedProvider> {
    const id = uuidv7();
    try {
      await this.db.insert(providers).values({
        id,
        slug: input.slug,
        name: input.name,
        baseUrl: input.baseUrl,
        apiKeyEnc: input.apiKey ? this.box.seal(input.apiKey, secretContext(id, 'api_key')) : null,
        headersEnc: this.sealHeaders(id, input.headers),
        strictJson: input.strictJson,
        enabled: input.enabled,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, 'provider_slug_taken', `A provider with slug "${input.slug}" already exists`);
      }
      throw error;
    }
    await this.registry.reload();
    this.logger.info('Provider created', { providerId: id, slug: input.slug });
    return this.get(id);
  }

  async update(id: string, input: UpdateProviderInput): Promise<ResolvedProvider> {
    this.get(id);
    const patch: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
    if (input.strictJson !== undefined) patch.strictJson = input.strictJson;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.apiKey !== undefined) {
      patch.apiKeyEnc =
        input.apiKey === null ? null : this.box.seal(input.apiKey, secretContext(id, 'api_key'));
    }
    if (input.headers !== undefined) patch.headersEnc = this.sealHeaders(id, input.headers ?? undefined);
    await this.db.update(providers).set(patch).where(eq(providers.id, id));
    await this.registry.reload();
    this.logger.info('Provider updated', { providerId: id, fields: Object.keys(input) });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const provider = this.get(id);
    await this.db.delete(providers).where(eq(providers.id, id));
    await this.registry.reload();
    this.logger.info('Provider deleted', { providerId: id, slug: provider.slug });
  }

  /** Re-reads `GET {baseUrl}/models`. Manual entries are kept; discovered entries the server no longer lists are dropped. */
  async refreshModels(id: string): Promise<ResolvedModel[]> {
    const provider = this.get(id);
    let discovered: Awaited<ReturnType<typeof discoverModels>>;
    try {
      discovered = await discoverModels(provider);
    } catch (error) {
      if (error instanceof DiscoveryError) throw new ApiError(502, 'discovery_failed', error.message);
      throw error;
    }
    const now = new Date();
    await this.db.transaction(async (tx) => {
      for (const model of discovered) {
        await tx
          .insert(providerModels)
          .values({
            providerId: id,
            modelId: model.modelId,
            kind: model.kind,
            source: 'discovered',
            discoveredAt: now,
          })
          .onConflictDoUpdate({
            target: [providerModels.providerId, providerModels.modelId],
            set: { source: 'discovered', discoveredAt: now },
          });
      }
      const ids = discovered.map((m) => m.modelId);
      await tx
        .delete(providerModels)
        .where(
          and(
            eq(providerModels.providerId, id),
            eq(providerModels.source, 'discovered'),
            ids.length > 0 ? notInArray(providerModels.modelId, ids) : undefined,
          ),
        );
    });
    await this.registry.reload();
    return this.get(id).models;
  }

  /** For servers without a /models endpoint, or to correct a guessed kind. */
  async addModel(id: string, input: AddModelInput): Promise<ResolvedModel[]> {
    this.get(id);
    await this.db
      .insert(providerModels)
      .values({ providerId: id, modelId: input.modelId, kind: input.kind, source: 'manual' })
      .onConflictDoUpdate({
        target: [providerModels.providerId, providerModels.modelId],
        set: { kind: input.kind },
      });
    await this.registry.reload();
    return this.get(id).models;
  }

  async removeModel(id: string, modelId: string): Promise<void> {
    this.get(id);
    const deleted = await this.db
      .delete(providerModels)
      .where(and(eq(providerModels.providerId, id), eq(providerModels.modelId, modelId)))
      .returning({ modelId: providerModels.modelId });
    if (deleted.length === 0)
      throw new ApiError(404, 'model_not_found', `Provider has no model "${modelId}"`);
    await this.registry.reload();
  }

  /** Rejects references to unknown or disabled providers, and to models the provider doesn't list. */
  assertUsable(ref: ModelRef, label: string): void {
    const provider = this.registry.get(ref.provider);
    if (!provider)
      throw new ApiError(400, 'unknown_provider', `${label}: no provider with slug "${ref.provider}"`);
    if (!provider.enabled)
      throw new ApiError(400, 'provider_disabled', `${label}: provider "${ref.provider}" is disabled`);
    if (provider.models.length > 0 && !provider.models.some((m) => m.modelId === ref.model)) {
      throw new ApiError(
        400,
        'unknown_model',
        `${label}: provider "${ref.provider}" has no model "${ref.model}". Refresh its models or add it manually.`,
      );
    }
  }

  private sealHeaders(id: string, headers: Record<string, string> | undefined): string | null {
    if (!headers || Object.keys(headers).length === 0) return null;
    return this.box.seal(JSON.stringify(headers), secretContext(id, 'headers'));
  }
}
