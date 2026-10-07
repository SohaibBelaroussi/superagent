import { posix } from 'node:path';
import type { SkillSource, SkillSourceEntry, SkillSourceStat } from '@mastra/core/workspace';
import type { Skill } from '@superagent/shared';
import { and, eq, like } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { pluginFiles, plugins, type SkillRow, skills } from '../../db/schema';
import { ApiError } from '../../http/problem';

/** Skills' files Mastra reads: kept in memory up to this much, least recently used out first. */
const CACHE_BYTES = 256 * 1024 * 1024;
const ROOT = '/skills';
const TEXT =
  /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|xsd|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|rb|go|rs|java|sql|svg|ini|cfg|conf)$/i;

export interface SkillEntry extends SkillRow {
  plugin: string;
}

/** A skill's files, relative to its folder. */
interface Snapshot {
  files: Map<string, Buffer>;
  dirs: Map<string, Set<string>>;
  bytes: number;
  at: Date;
}

/**
 * Imported skills (decision D37): pinned files in the database, served to Mastra through a read-only
 * SkillSource at /skills/<id>/<name>. Agents get them per request, from their version and department.
 */
export class SkillStore {
  private byId = new Map<string, SkillEntry>();
  private readonly cache = new Map<string, Snapshot>();
  private cached = 0;
  readonly source: SkillSource;

  constructor(private readonly db: Db) {
    this.source = this.createSource();
  }

  async load(): Promise<void> {
    const rows = await this.db
      .select({ skill: skills, plugin: plugins.name })
      .from(skills)
      .innerJoin(plugins, eq(plugins.id, skills.pluginId));
    this.byId = new Map(rows.map(({ skill, plugin }) => [skill.id, { ...skill, plugin }]));
    this.cache.clear();
    this.cached = 0;
  }

  list(): SkillEntry[] {
    return [...this.byId.values()].sort((a, b) =>
      `${a.plugin}/${a.name}`.localeCompare(`${b.plugin}/${b.name}`),
    );
  }

  async get(id: string): Promise<Skill> {
    const skill = this.byId.get(id);
    if (!skill) throw new ApiError(404, 'skill_not_found', 'No skill with this id');
    const snapshot = await this.snapshot(skill);
    return { ...this.summary(skill), files: [...snapshot.files.keys()].sort() };
  }

  summary(skill: SkillEntry): Omit<Skill, 'files'> {
    return {
      id: skill.id,
      ref: `${skill.plugin}/${skill.name}`,
      plugin: skill.plugin,
      name: skill.name,
      description: skill.description,
      license: skill.license,
      compatibility: skill.compatibility,
      bytes: skill.sizeBytes,
      createdAt: skill.createdAt.toISOString(),
    };
  }

  /** The skills references name: a plugin's name means all of its skills. Unknown ones are skipped. */
  resolve(refs: string[]): SkillEntry[] {
    const found = new Map<string, SkillEntry>();
    for (const ref of refs) {
      const [plugin, name] = ref.split('/');
      for (const skill of this.byId.values()) {
        if (skill.plugin === plugin && (!name || skill.name === name)) found.set(skill.id, skill);
      }
    }
    return [...found.values()];
  }

  /** The folders Mastra reads skills from, one per skill; a name is served once (the first wins). */
  pathsFor(refs: string[]): string[] {
    const names = new Set<string>();
    return this.resolve(refs).flatMap((skill) => {
      if (names.has(skill.name)) return [];
      names.add(skill.name);
      return [`${ROOT}/${skill.id}/${skill.name}`];
    });
  }

  /** Refuses references to plugins or skills that don't exist. */
  assertRefs(refs: string[]): void {
    for (const ref of refs) {
      const [plugin, name] = ref.split('/');
      const known = [...this.byId.values()].some((s) => s.plugin === plugin && (!name || s.name === name));
      if (!known) {
        throw new ApiError(
          400,
          'unknown_skill',
          name ? `No skill "${name}" in plugin "${plugin}"` : `No plugin "${plugin}" with skills`,
        );
      }
    }
  }

  // --- the SkillSource ---

  private async snapshot(skill: SkillEntry): Promise<Snapshot> {
    const hit = this.cache.get(skill.id);
    if (hit) {
      // Most recently used last.
      this.cache.delete(skill.id);
      this.cache.set(skill.id, hit);
      return hit;
    }
    const rows = await this.db
      .select({ path: pluginFiles.path, content: pluginFiles.content })
      .from(pluginFiles)
      .where(
        and(
          eq(pluginFiles.pluginId, skill.pluginId),
          // Postgres escapes LIKE wildcards with a backslash by default.
          like(pluginFiles.path, `${skill.dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`),
        ),
      );
    const snapshot: Snapshot = {
      files: new Map(),
      dirs: new Map([['', new Set()]]),
      bytes: 0,
      at: skill.createdAt,
    };
    for (const row of rows) {
      const rel = row.path.slice(skill.dir.length + 1);
      snapshot.files.set(rel, row.content);
      snapshot.bytes += row.content.length;
      let child = rel;
      for (let dir = posix.dirname(rel); ; dir = posix.dirname(dir)) {
        const key = dir === '.' ? '' : dir;
        if (!snapshot.dirs.has(key)) snapshot.dirs.set(key, new Set());
        snapshot.dirs.get(key)?.add(posix.basename(child));
        if (key === '') break;
        child = dir;
      }
    }
    this.cache.set(skill.id, snapshot);
    this.cached += snapshot.bytes;
    for (const [id, old] of this.cache) {
      if (this.cached <= CACHE_BYTES || id === skill.id) break;
      this.cache.delete(id);
      this.cached -= old.bytes;
    }
    return snapshot;
  }

  /**
   * Splits a path Mastra asks for: `/skills`, `/skills/<id>`, or `/skills/<id>/<name>[/rel]`.
   * Anything else, or a skill not attached through this store, doesn't exist.
   */
  private locate(
    path: string,
  ):
    | { kind: 'root' }
    | { kind: 'id'; skill: SkillEntry }
    | { kind: 'inside'; skill: SkillEntry; rel: string }
    | undefined {
    const normal = posix.normalize(`/${path.replace(/\\/g, '/')}`).replace(/\/+$/, '') || '/';
    if (normal === ROOT) return { kind: 'root' };
    if (!normal.startsWith(`${ROOT}/`)) return undefined;
    const [id, name, ...rest] = normal.slice(ROOT.length + 1).split('/');
    const skill = id ? this.byId.get(id) : undefined;
    if (!skill) return undefined;
    if (name === undefined) return { kind: 'id', skill };
    if (name !== skill.name) return undefined;
    return { kind: 'inside', skill, rel: rest.join('/') };
  }

  private createSource(): SkillSource {
    const missing = (path: string) =>
      Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
    const dirStat = (name: string, at: Date): SkillSourceStat => ({
      name,
      type: 'directory',
      size: 0,
      createdAt: at,
      modifiedAt: at,
    });
    return {
      exists: async (path) => {
        const at = this.locate(path);
        if (!at) return false;
        if (at.kind !== 'inside') return true;
        const snapshot = await this.snapshot(at.skill);
        return snapshot.files.has(at.rel) || snapshot.dirs.has(at.rel);
      },
      stat: async (path) => {
        const at = this.locate(path);
        if (!at) throw missing(path);
        const now = new Date(0);
        if (at.kind === 'root') return dirStat('skills', now);
        if (at.kind === 'id') return dirStat(at.skill.id, at.skill.createdAt);
        const snapshot = await this.snapshot(at.skill);
        const file = snapshot.files.get(at.rel);
        if (file) {
          return {
            name: posix.basename(at.rel),
            type: 'file',
            size: file.length,
            createdAt: snapshot.at,
            modifiedAt: snapshot.at,
          };
        }
        if (snapshot.dirs.has(at.rel)) return dirStat(posix.basename(at.rel) || at.skill.name, snapshot.at);
        throw missing(path);
      },
      readFile: async (path) => {
        const at = this.locate(path);
        if (at?.kind !== 'inside') throw missing(path);
        const file = (await this.snapshot(at.skill)).files.get(at.rel);
        if (!file) throw missing(path);
        return TEXT.test(at.rel) ? file.toString('utf8') : file;
      },
      readdir: async (path): Promise<SkillSourceEntry[]> => {
        const at = this.locate(path);
        if (!at) throw missing(path);
        if (at.kind === 'root') return [];
        if (at.kind === 'id') return [{ name: at.skill.name, type: 'directory' }];
        const snapshot = await this.snapshot(at.skill);
        const children = snapshot.dirs.get(at.rel);
        if (!children) throw missing(path);
        return [...children].map((name) => ({
          name,
          type: snapshot.dirs.has(at.rel ? `${at.rel}/${name}` : name) ? 'directory' : 'file',
        }));
      },
      realpath: async (path) => posix.normalize(`/${path.replace(/\\/g, '/')}`),
    };
  }
}
