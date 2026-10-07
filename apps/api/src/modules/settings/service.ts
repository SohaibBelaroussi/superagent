import type { ModelKind, ModelRef, ModelRole, Settings, UpdateSettingsInput } from '@superagent/shared';
import { ModelRolesSchema, SettingsSchema } from '@superagent/shared';
import type { Db } from '../../db/client';
import { settings as settingsTable } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { Mutex } from '../../util/mutex';
import { isValidTimezone } from '../../util/text';
import { routerId, unconfiguredRouterId } from '../providers/model-ref';

export const MODEL_ROLES: readonly ModelRole[] = ['default', 'fast', 'embedding'];

type SettingsKey = keyof Settings;
const KEYS: readonly SettingsKey[] = ['models', 'timezone', 'concurrency'];

/** Server-wide settings, cached in memory and persisted as one row per top-level key. */
export class SettingsService {
  private current: Settings;
  /** Serializes configuration writes that must not interleave (settings updates, provider deletion). */
  readonly lock = new Mutex();

  constructor(
    private readonly db: Db,
    private readonly defaults: Settings,
  ) {
    this.current = defaults;
  }

  static defaultsFor(timezone: string): Settings {
    return {
      models: { default: null, fast: null, embedding: null },
      timezone,
      concurrency: { global: 10, perAgent: 5 },
    };
  }

  async load(): Promise<Settings> {
    const rows = await this.db.select().from(settingsTable);
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const merged = {
      ...this.defaults,
      ...stored,
      models: { ...this.defaults.models, ...ModelRolesSchema.partial().safeParse(stored.models).data },
    };
    const parsed = SettingsSchema.safeParse(merged);
    this.current = parsed.success ? parsed.data : this.defaults;
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  /** Router id for a model role. Unset roles resolve to a placeholder the gateway rejects with a clear message. */
  modelRouterId(role: ModelRole): string {
    const ref = this.current.models[role];
    return ref ? routerId(ref) : unconfiguredRouterId(role);
  }

  rolesUsingProvider(slug: string): ModelRole[] {
    return MODEL_ROLES.filter((role) => this.current.models[role]?.provider === slug);
  }

  /**
   * Serialized with `lock`, which also guards provider deletion: concurrent updates can't lose each
   * other's changes, and a role can't be pointed at a provider that is being deleted.
   */
  update(
    input: UpdateSettingsInput,
    assertUsable: (ref: ModelRef, label: string, kind: ModelKind) => void,
  ): Promise<Settings> {
    return this.lock.run(async () => {
      const next: Settings = {
        models: { ...this.current.models, ...input.models },
        timezone: input.timezone ?? this.current.timezone,
        concurrency: { ...this.current.concurrency, ...input.concurrency },
      };
      if (!isValidTimezone(next.timezone)) {
        throw new ApiError(400, 'invalid_timezone', `"${next.timezone}" is not an IANA timezone`);
      }
      for (const role of MODEL_ROLES) {
        const ref = input.models?.[role];
        if (ref) assertUsable(ref, `models.${role}`, role === 'embedding' ? 'embedding' : 'chat');
      }

      await this.db.transaction(async (tx) => {
        for (const key of KEYS) {
          if (input[key] === undefined) continue;
          await tx
            .insert(settingsTable)
            .values({ key, value: next[key] })
            .onConflictDoUpdate({
              target: settingsTable.key,
              set: { value: next[key], updatedAt: new Date() },
            });
        }
      });
      this.current = next;
      return next;
    });
  }
}
