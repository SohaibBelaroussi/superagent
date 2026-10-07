import type { ModelKind } from '@superagent/shared';
import type { SecretBox } from '../../crypto/secret-box';
import type { Db } from '../../db/client';
import { providerModels, providers } from '../../db/schema';

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
  strictJson: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  models: ResolvedModel[];
}

export const secretContext = (providerId: string, field: 'api_key' | 'headers') =>
  `provider:${providerId}:${field}`;

/**
 * In-memory view of every provider, rebuilt from the database after each change.
 * The model gateway reads it on every request, so edits apply without a restart.
 */
export class ProviderRegistry {
  private bySlug = new Map<string, ResolvedProvider>();
  private byId = new Map<string, ResolvedProvider>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async reload(): Promise<void> {
    const [rows, modelRows] = await Promise.all([
      this.db.select().from(providers),
      this.db.select().from(providerModels),
    ]);
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

    const bySlug = new Map<string, ResolvedProvider>();
    const byId = new Map<string, ResolvedProvider>();
    for (const row of rows) {
      const resolved: ResolvedProvider = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey: row.apiKeyEnc ? this.box.open(row.apiKeyEnc, secretContext(row.id, 'api_key')) : null,
        headers: row.headersEnc
          ? (JSON.parse(this.box.open(row.headersEnc, secretContext(row.id, 'headers'))) as Record<
              string,
              string
            >)
          : {},
        strictJson: row.strictJson,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        models: (modelsByProvider.get(row.id) ?? []).sort((a, b) => a.modelId.localeCompare(b.modelId)),
      };
      bySlug.set(row.slug, resolved);
      byId.set(row.id, resolved);
    }
    this.bySlug = bySlug;
    this.byId = byId;
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
}
