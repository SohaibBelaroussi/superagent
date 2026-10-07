import { randomUUID } from 'node:crypto';
import type { ConfigValue, PutSecretInput, Secret } from '@superagent/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { SecretBox } from '../../crypto/secret-box';
import type { Db } from '../../db/client';
import { mcpServers, plugins, type SecretRow, secrets } from '../../db/schema';
import { ApiError } from '../../http/problem';

const context = (id: string) => `secret:${id}`;

/** The names of the secrets a header or environment map refers to. */
export function secretNames(values: Record<string, ConfigValue> | undefined): string[] {
  return Object.values(values ?? {}).flatMap((value) => ('secret' in value ? [value.secret] : []));
}

/**
 * The secrets vault (decision D35): values sealed with SecretBox, bound to each secret's id, never
 * returned or logged. MCP servers' headers and environment refer to secrets by name.
 */
export class SecretService {
  private readonly listeners = new Set<(name: string) => void>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Called with a secret's name after its value changes (servers using it reconnect). */
  onChange(listener: (name: string) => void): void {
    this.listeners.add(listener);
  }

  async list(): Promise<Secret[]> {
    const rows = await this.db
      .select({ secret: secrets, plugin: plugins.name })
      .from(secrets)
      .leftJoin(plugins, eq(plugins.id, secrets.pluginId))
      .orderBy(secrets.name);
    const users = await this.users();
    return rows.map(({ secret, plugin }) => this.present(secret, plugin, users.get(secret.name) ?? []));
  }

  /** Creates a secret or replaces its value (and description, if given). */
  async put(name: string, input: PutSecretInput, options: { pluginId?: string } = {}): Promise<Secret> {
    const [existing] = await this.db.select().from(secrets).where(eq(secrets.name, name));
    if (existing) {
      await this.db
        .update(secrets)
        .set({
          valueEnc: this.box.seal(input.value, context(existing.id)),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(secrets.id, existing.id));
      for (const listener of this.listeners) listener(name);
    } else {
      const id = randomUUID();
      await this.db.insert(secrets).values({
        id,
        name,
        description: input.description ?? '',
        valueEnc: this.box.seal(input.value, context(id)),
        pluginId: options.pluginId ?? null,
      });
    }
    return this.get(name);
  }

  /**
   * A plugin's secret, sealed, for its install to insert in its own transaction: inserts never
   * replace a secret (a clash fails the install).
   */
  sealed(name: string, value: string, description: string, pluginId: string): typeof secrets.$inferInsert {
    const id = randomUUID();
    return { id, name, description, valueEnc: this.box.seal(value, context(id)), pluginId };
  }

  /**
   * Before a plugin goes: its secrets that servers of other origins use stay, owned by nobody, so
   * uninstalling never takes a credential away from them. Returns their names.
   */
  async release(pluginId: string): Promise<string[]> {
    const owned = await this.db
      .select({ name: secrets.name })
      .from(secrets)
      .where(eq(secrets.pluginId, pluginId));
    if (owned.length === 0) return [];
    const others = await this.db
      .select({ headers: mcpServers.headers, env: mcpServers.env, pluginId: mcpServers.pluginId })
      .from(mcpServers);
    const used = new Set(
      others
        .filter((row) => row.pluginId !== pluginId)
        .flatMap((row) => [...secretNames(row.headers), ...secretNames(row.env)]),
    );
    const kept = owned.map((row) => row.name).filter((name) => used.has(name));
    if (kept.length > 0) {
      await this.db
        .update(secrets)
        .set({ pluginId: null, updatedAt: new Date() })
        .where(and(eq(secrets.pluginId, pluginId), inArray(secrets.name, kept)));
    }
    return kept;
  }

  async get(name: string): Promise<Secret> {
    const [row] = await this.db
      .select({ secret: secrets, plugin: plugins.name })
      .from(secrets)
      .leftJoin(plugins, eq(plugins.id, secrets.pluginId))
      .where(eq(secrets.name, name));
    if (!row) throw new ApiError(404, 'secret_not_found', `No secret named ${name}`);
    return this.present(row.secret, row.plugin, (await this.users()).get(name) ?? []);
  }

  /** Deletes a secret. Refused while an MCP server uses it. */
  async remove(name: string): Promise<void> {
    const secret = await this.get(name);
    if (secret.usedBy.length > 0) {
      throw new ApiError(
        409,
        'secret_in_use',
        `MCP servers use this secret (${secret.usedBy.join(', ')}): change them first`,
      );
    }
    await this.db.delete(secrets).where(eq(secrets.name, name));
  }

  /** Whether these secrets exist; the missing names otherwise. */
  async missing(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await this.db
      .select({ name: secrets.name })
      .from(secrets)
      .where(inArray(secrets.name, [...new Set(names)]));
    const found = new Set(rows.map((row) => row.name));
    return [...new Set(names)].filter((name) => !found.has(name));
  }

  /** The values of a header or environment map, secrets opened. For the services that use them. */
  async resolve(values: Record<string, ConfigValue>): Promise<Record<string, string>> {
    const names = secretNames(values);
    const rows =
      names.length > 0 ? await this.db.select().from(secrets).where(inArray(secrets.name, names)) : [];
    const byName = new Map(rows.map((row) => [row.name, row]));
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if ('value' in value) {
        resolved[key] = value.value;
        continue;
      }
      const row = byName.get(value.secret);
      if (!row) throw new ApiError(409, 'secret_missing', `The secret ${value.secret} does not exist`);
      resolved[key] = this.box.open(row.valueEnc, context(row.id));
    }
    return resolved;
  }

  /** Secret name -> the slugs of the MCP servers that use it. */
  private async users(): Promise<Map<string, string[]>> {
    const rows = await this.db
      .select({ slug: mcpServers.slug, headers: mcpServers.headers, env: mcpServers.env })
      .from(mcpServers);
    const users = new Map<string, string[]>();
    for (const row of rows) {
      for (const name of new Set([...secretNames(row.headers), ...secretNames(row.env)])) {
        users.set(name, [...(users.get(name) ?? []), row.slug]);
      }
    }
    return users;
  }

  private present(row: SecretRow, plugin: string | null, usedBy: string[]): Secret {
    return {
      name: row.name,
      description: row.description,
      plugin,
      usedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
