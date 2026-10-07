import type { IMastraLogger } from '@mastra/core/logger';
import type { ModelKind, ModelPrice } from '@superagent/shared';
import type { SecretBox } from '../../crypto/secret-box';
import type { Db } from '../../db/client';
import { modelPrices, providerModels, providers } from '../../db/schema';

export interface ResolvedModel {
  modelId: string;
  kind: ModelKind;
  source: 'discovered' | 'manual';
  enabled: boolean;
  discoveredAt: Date | null;
}

/** A provider with its secrets decrypted. Lives only in memory. */
export interface ResolvedProvider {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  /** false when the stored secrets can't be decrypted (e.g. SUPERAGENT_ENCRYPTION_KEY changed). */
  secretsReadable: boolean;
  strictJson: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  models: ResolvedModel[];
  /** By model id; a model without one costs nothing (decision D40). */
  prices: Map<string, ModelPrice>;
}

/**
 * Authenticated context for a sealed secret. Binding the base URL means a database edit that points a
 * provider at another server can't make it send the existing key there: the secret stops opening.
 */
export const secretContext = (providerId: string, field: 'api_key' | 'headers', baseUrl: string) =>
  `provider:${providerId}:${field}:${baseUrl}`;

/**
 * In-memory view of every provider, rebuilt from the database after each change.
 * The model gateway reads it on every request, so edits apply without a restart.
 */
export class ProviderRegistry {
  private bySlug = new Map<string, ResolvedProvider>();
  private byId = new Map<string, ResolvedProvider>();
  private reloads: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly logger: IMastraLogger,
  ) {}

  /**
   * Rebuilds the view. Reloads run one after another: each starts after the previous one finished, so
   * it reads everything written before it was asked for, and its caller sees that once it resolves.
   */
  reload(): Promise<void> {
    const next = this.reloads.then(
      () => this.load(),
      () => this.load(),
    );
    this.reloads = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    // One snapshot for all three tables, so models and prices always match their providers.
    const { rows, modelRows, priceRows } = await this.db.transaction(
      async (tx) => ({
        rows: await tx.select().from(providers),
        modelRows: await tx.select().from(providerModels),
        priceRows: await tx.select().from(modelPrices),
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const modelsByProvider = new Map<string, ResolvedModel[]>();
    for (const m of modelRows) {
      const list = modelsByProvider.get(m.providerId) ?? [];
      list.push({
        modelId: m.modelId,
        kind: m.kind,
        source: m.source,
        enabled: m.enabled,
        discoveredAt: m.discoveredAt,
      });
      modelsByProvider.set(m.providerId, list);
    }

    const pricesByProvider = new Map<string, Map<string, ModelPrice>>();
    for (const p of priceRows) {
      const prices = pricesByProvider.get(p.providerId) ?? new Map<string, ModelPrice>();
      prices.set(p.modelId, {
        inputUsd: p.inputUsd,
        cachedInputUsd: p.cachedInputUsd,
        outputUsd: p.outputUsd,
      });
      pricesByProvider.set(p.providerId, prices);
    }

    const bySlug = new Map<string, ResolvedProvider>();
    const byId = new Map<string, ResolvedProvider>();
    for (const row of rows) {
      const secrets = this.openSecrets(row);
      const resolved: ResolvedProvider = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        baseUrl: row.baseUrl,
        ...secrets,
        strictJson: row.strictJson,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        models: (modelsByProvider.get(row.id) ?? []).sort((a, b) => a.modelId.localeCompare(b.modelId)),
        prices: pricesByProvider.get(row.id) ?? new Map(),
      };
      bySlug.set(row.slug, resolved);
      byId.set(row.id, resolved);
    }
    this.bySlug = bySlug;
    this.byId = byId;
  }

  /** One unreadable row must not take the server down: it is loaded without secrets and flagged. */
  private openSecrets(
    row: typeof providers.$inferSelect,
  ): Pick<ResolvedProvider, 'apiKey' | 'headers' | 'secretsReadable'> {
    try {
      return {
        apiKey: row.apiKeyEnc
          ? this.box.open(row.apiKeyEnc, secretContext(row.id, 'api_key', row.baseUrl))
          : null,
        headers: row.headersEnc
          ? (JSON.parse(
              this.box.open(row.headersEnc, secretContext(row.id, 'headers', row.baseUrl)),
            ) as Record<string, string>)
          : {},
        secretsReadable: true,
      };
    } catch {
      this.logger.error('Provider secrets could not be decrypted', {
        provider: row.slug,
        hint: 'SUPERAGENT_ENCRYPTION_KEY changed, or the row was edited. Set the key again with PATCH /v1/providers/:id.',
      });
      return { apiKey: null, headers: {}, secretsReadable: false };
    }
  }

  get(slug: string): ResolvedProvider | undefined {
    return this.bySlug.get(slug);
  }

  getById(id: string): ResolvedProvider | undefined {
    return this.byId.get(id);
  }

  list(): ResolvedProvider[] {
    return [...this.bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** What a provider's model costs, if the owner priced it. */
  priceOf(slug: string | null, modelId: string | null): ModelPrice | undefined {
    if (!slug || !modelId) return undefined;
    return this.bySlug.get(slug)?.prices.get(modelId);
  }
}
