import { createHash } from 'node:crypto';
import { validateSkillContent } from '@mastra/core/skills';
import type { PluginInput } from '@superagent/shared';
import { ApiError } from '../../../http/problem';
import type { PluginFile } from './fetch';

export const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_PLUGINS_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
/** Where a plugin's files are inside its MCP container, and its servers' writable folder. */
export const CONTAINER_ROOT = '/opt/plugin';
export const CONTAINER_DATA = '/data';
const SKILL_LIMITS = { files: 2_000, bytes: 20 * 1024 * 1024 };
/** A placeholder as plugins write it: `${NAME}`. */
const placeholder = (name: string) => `\${${name}}`;
const SENSITIVE = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i;

export type PluginFormat = 'agent-plugins' | 'codex' | 'claude' | 'skills';

export interface PlannedSkill {
  name: string;
  description: string;
  dir: string;
  license: string | null;
  compatibility: string | null;
  files: number;
  bytes: number;
}

export interface PlannedServer {
  key: string;
  slug: string;
  transport: 'http' | 'stdio';
  url: string | null;
  /** Values may hold `${NAME}` placeholders filled from install inputs. */
  headers: Record<string, string>;
  runtime: 'bundled' | 'npm' | 'uv' | null;
  package: string | null;
  /** An exact version, or `latest` (pinned when installed). */
  version: string | null;
  /** npm: which of the package's bins; uv: which console script. */
  bin: string | null;
  /** bundled: the whole command; npm and uv: the arguments after the package's executable. */
  command: string[];
  cwd: string | null;
  env: Record<string, string>;
}

export interface PluginPlan {
  format: PluginFormat;
  name: string;
  title: string;
  version: string | null;
  description: string;
  license: string | null;
  homepage: string | null;
  skills: PlannedSkill[];
  servers: PlannedServer[];
  inputs: PluginInput[];
  skipped: Array<{ component: string; reason: string }>;
  warnings: string[];
}

type Json = Record<string, unknown>;

function json(files: Map<string, PluginFile>, path: string): Json | undefined {
  const file = files.get(path);
  if (!file) return undefined;
  try {
    const value = JSON.parse(file.data.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Json;
  } catch (error) {
    throw new ApiError(422, 'invalid_plugin', `${path} is not valid JSON: ${(error as Error).message}`);
  }
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

/** A folder path from a manifest, relative to the plugin's root: "./skills/" -> "skills". */
function folder(path: string): string | null {
  const clean = path.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean === '.') return '';
  if (clean.startsWith('/') || clean.split('/').some((part) => part === '..' || part === '')) return null;
  return clean;
}

/** A slug for a plugin's MCP server: `<plugin>-<server>`, lowercase, at most 32 characters. */
export function serverSlug(plugin: string, key: string, taken: Set<string>): string {
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  const base = clean(`${plugin}-${key}`);
  // Too long: the plugin's part is cut (and a hash keeps it unique), the server's key stays readable.
  const keyPart = clean(key).slice(0, 16).replace(/-$/, '') || 'server';
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 6);
  const pluginPart = clean(plugin)
    .slice(0, 32 - keyPart.length - 9)
    .replace(/-$/, '');
  let slug = base.length <= 32 ? base : `${pluginPart}-${hash}-${keyPart}`;
  for (let n = 2; taken.has(slug); n++) slug = `${slug.slice(0, 29).replace(/-$/, '')}-${n}`;
  taken.add(slug);
  return slug;
}

/**
 * Reads a plugin's files into a plan (decision D38): which format it is (Agent Plugins 1.0 first,
 * then .codex-plugin, then .claude-plugin, then bare skills), its skills, its MCP servers mapped to
 * what superagent runs, the values its install needs, and everything it skips, with reasons.
 */
export function planPlugin(
  files: Map<string, PluginFile>,
  options: { takenSlugs?: Set<string>; fallbackName?: string } = {},
): PluginPlan {
  const root = json(files, 'plugin.json');
  const codex = json(files, '.codex-plugin/plugin.json');
  const claude = json(files, '.claude-plugin/plugin.json');
  let format: PluginFormat;
  let manifest: Json;
  const warnings: string[] = [];
  if (root && root.$schema === AGENT_PLUGINS_SCHEMA) {
    format = 'agent-plugins';
    manifest = root;
  } else if (root && typeof root.$schema === 'string' && root.$schema.includes('agent-plugins.org')) {
    throw new ApiError(422, 'invalid_plugin', `Unsupported Agent Plugins version: ${root.$schema}`);
  } else if (codex) {
    format = 'codex';
    manifest = codex;
  } else if (claude) {
    format = 'claude';
    manifest = claude;
  } else if ([...files.keys()].some((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))) {
    format = 'skills';
    manifest = {};
  } else {
    throw new ApiError(
      422,
      'invalid_plugin',
      'No plugin here: no plugin.json (Agent Plugins), .codex-plugin, .claude-plugin or skills/<name>/SKILL.md',
    );
  }

  const name =
    str(manifest.name)?.toLowerCase() ?? str(root?.name)?.toLowerCase() ?? options.fallbackName ?? null;
  if (
    !name ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(name) ||
    name.includes('..') ||
    name.includes('--')
  ) {
    throw new ApiError(
      422,
      'invalid_plugin',
      name ? `"${name}" is not a valid plugin name` : 'The plugin has no name (its manifest needs one)',
    );
  }
  const skipped: PluginPlan['skipped'] = [];
  if (format === 'agent-plugins') {
    const known = new Set([
      '$schema',
      'name',
      'version',
      'description',
      'author',
      'homepage',
      'repository',
      'license',
      'keywords',
      'extensions',
    ]);
    const unknown = Object.keys(manifest).filter((key) => !known.has(key));
    if (unknown.length > 0) warnings.push(`plugin.json: unknown fields ignored (${unknown.join(', ')})`);
  } else {
    for (const component of [
      'commands',
      'agents',
      'hooks',
      'lspServers',
      'outputStyles',
      'apps',
      'interface',
    ]) {
      if (manifest[component] !== undefined) {
        skipped.push({ component, reason: 'Not something superagent runs (ignored)' });
      }
    }
  }
  for (const [path, component] of [
    ['commands/', 'commands'],
    ['agents/', 'agents'],
    ['hooks/', 'hooks'],
  ] as const) {
    if (
      [...files.keys()].some((p) => p.startsWith(path)) &&
      !skipped.some((s) => s.component === component)
    ) {
      skipped.push({ component, reason: 'Not something superagent runs (ignored)' });
    }
  }

  const skills = planSkills(files, format, manifest, skipped, warnings);
  const inputs = new Map<string, PluginInput>();
  if (format === 'claude' && manifest.userConfig && typeof manifest.userConfig === 'object') {
    for (const [key, raw] of Object.entries(manifest.userConfig as Json)) {
      const entry = (raw ?? {}) as Json;
      inputs.set(key, {
        name: key,
        description: str(entry.description) ?? str(entry.title) ?? key,
        sensitive: entry.sensitive === true,
        required: entry.required === true && entry.default === undefined,
      });
    }
  }
  const servers = planServers(
    files,
    format,
    manifest,
    name,
    options.takenSlugs ?? new Set(),
    skipped,
    inputs,
  );
  return {
    format,
    name,
    title: str((manifest.interface as Json | undefined)?.displayName) ?? str(manifest.displayName) ?? name,
    version: str(manifest.version),
    description: str(manifest.description) ?? '',
    license: str(manifest.license),
    homepage:
      str(manifest.homepage) ?? (typeof manifest.repository === 'string' ? manifest.repository : null),
    skills,
    servers,
    inputs: [...inputs.values()],
    skipped,
    warnings,
  };
}

function planSkills(
  files: Map<string, PluginFile>,
  format: PluginFormat,
  manifest: Json,
  skipped: PluginPlan['skipped'],
  warnings: string[],
): PlannedSkill[] {
  const folders = new Set<string>(['skills']);
  if (format === 'codex' || format === 'claude') {
    for (const path of strings(manifest.skills)) {
      const dir = folder(path);
      if (dir === null) skipped.push({ component: `skills ${path}`, reason: 'A path outside the plugin' });
      else if (dir === '') warnings.push('A skill at the plugin root is not supported: put it under skills/');
      else folders.add(dir);
    }
  }
  if (files.has('SKILL.md'))
    warnings.push('A skill at the plugin root is not supported: put it under skills/');
  const planned: PlannedSkill[] = [];
  const names = new Set<string>();
  for (const container of folders) {
    const dirs = new Set(
      [...files.keys()]
        .filter(
          (path) =>
            path.startsWith(`${container}/`) && path.slice(container.length + 1).split('/')[1] === 'SKILL.md',
        )
        .map((path) => path.slice(0, path.lastIndexOf('/'))),
    );
    // A folder that holds SKILL.md itself (Claude lets "skills" name one skill's folder).
    if (files.has(`${container}/SKILL.md`)) dirs.add(container);
    for (const dir of [...dirs].sort()) {
      const folderName = dir.split('/').pop() as string;
      const content = files.get(`${dir}/SKILL.md`)?.data.toString('utf8') ?? '';
      const result = validateSkillContent({ content, directoryName: folderName });
      const meta = (result.metadata ?? {}) as Json;
      const name = str(meta.name);
      if (!result.valid || !name) {
        skipped.push({
          component: `skill ${dir}`,
          reason: (result.errors ?? []).join('; ') || 'Invalid SKILL.md',
        });
        continue;
      }
      if (names.has(name)) {
        skipped.push({ component: `skill ${dir}`, reason: `Another skill is named ${name}` });
        continue;
      }
      const own = [...files.entries()].filter(([path]) => path.startsWith(`${dir}/`));
      const bytes = own.reduce((sum, [, file]) => sum + file.data.length, 0);
      if (own.length > SKILL_LIMITS.files || bytes > SKILL_LIMITS.bytes) {
        skipped.push({ component: `skill ${dir}`, reason: 'Too large (2,000 files and 20 MiB at most)' });
        continue;
      }
      names.add(name);
      planned.push({
        name,
        description: str(meta.description) ?? '',
        dir,
        license: str(meta.license),
        compatibility: str(meta.compatibility),
        files: own.length,
        bytes,
      });
    }
  }
  return planned;
}

/** The MCP server definitions a plugin declares, by name. */
function serverDefinitions(
  files: Map<string, PluginFile>,
  format: PluginFormat,
  manifest: Json,
  skipped: PluginPlan['skipped'],
): Record<string, Json> {
  const unwrap = (config: Json | undefined): Record<string, Json> => {
    if (!config) return {};
    const servers = (config.mcpServers ?? config) as Json;
    return Object.fromEntries(
      Object.entries(servers).filter(
        ([key, value]) => key !== '$schema' && value && typeof value === 'object',
      ),
    ) as Record<string, Json>;
  };
  if (format === 'agent-plugins') {
    const config = json(files, 'mcp.json');
    if (config && config.$schema !== AGENT_PLUGINS_MCP_SCHEMA) {
      skipped.push({
        component: 'mcp.json',
        reason: 'Its $schema is not Agent Plugins 1.0 (MCP servers skipped)',
      });
      return {};
    }
    return unwrap(config ? ((config.mcpServers as Json | undefined) ?? {}) : undefined);
  }
  if (format === 'skills') return {};
  const declared = manifest.mcpServers;
  if (typeof declared === 'string') {
    const path = folder(declared);
    return path ? unwrap(json(files, path)) : {};
  }
  if (Array.isArray(declared)) {
    const merged: Record<string, Json> = {};
    for (const entry of declared) {
      if (typeof entry === 'string') {
        const path = folder(entry);
        if (path) Object.assign(merged, unwrap(json(files, path)));
      } else if (entry && typeof entry === 'object') Object.assign(merged, unwrap(entry as Json));
    }
    return merged;
  }
  if (declared && typeof declared === 'object') return unwrap(declared as Json);
  return unwrap(json(files, '.mcp.json'));
}

function planServers(
  files: Map<string, PluginFile>,
  format: PluginFormat,
  manifest: Json,
  plugin: string,
  taken: Set<string>,
  skipped: PluginPlan['skipped'],
  inputs: Map<string, PluginInput>,
): PlannedServer[] {
  const planned: PlannedServer[] = [];
  const definitions = serverDefinitions(files, format, manifest, skipped);
  const strict = format === 'agent-plugins';
  // Agent Plugins expands only its two placeholders; Claude and Codex also take user values.
  const expand = (value: string): string => {
    let out = value
      .replaceAll(placeholder('PLUGIN_ROOT'), CONTAINER_ROOT)
      .replaceAll(placeholder('PLUGIN_DATA'), CONTAINER_DATA);
    if (strict) return out;
    out = out
      .replaceAll(placeholder('CLAUDE_PLUGIN_ROOT'), CONTAINER_ROOT)
      .replaceAll(placeholder('CLAUDE_PLUGIN_DATA'), CONTAINER_DATA);
    return out.replace(
      /\$\{(user_config\.)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (whole, userConfig, variable, fallback) => {
        if (!userConfig && ['HOME', 'PATH', 'CLAUDE_PROJECT_DIR'].includes(variable)) return whole;
        if (!inputs.has(variable)) {
          inputs.set(variable, {
            name: variable,
            description: `Used by the plugin's MCP servers (${variable})`,
            sensitive: SENSITIVE.test(variable),
            required: fallback === undefined,
          });
        }
        return fallback === undefined ? `\${${variable}}` : `\${${variable}:-${fallback}}`;
      },
    );
  };
  const record = (value: unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries((value ?? {}) as Json)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, expand(v as string)]),
    );
  for (const [key, definition] of Object.entries(definitions)) {
    const skip = (reason: string) => skipped.push({ component: `MCP server ${key}`, reason });
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
      skip('Its name has characters superagent does not take');
      continue;
    }
    const type = str(definition.type) ?? (definition.url ? 'http' : 'stdio');
    if (strict && !definition.type) {
      skip('Agent Plugins servers need a "type"');
      continue;
    }
    if (type === 'sse' || type === 'ws') {
      skip(`The ${type} transport is not supported (Streamable HTTP and stdio are)`);
      continue;
    }
    const base = {
      key,
      slug: '',
      headers: {} as Record<string, string>,
      env: {} as Record<string, string>,
      url: null as string | null,
      runtime: null as PlannedServer['runtime'],
      package: null as string | null,
      version: null as string | null,
      bin: null as string | null,
      command: [] as string[],
      cwd: null as string | null,
    };
    if (type === 'http' || type === 'streamable-http') {
      const url = str(definition.url);
      let parsed: URL | undefined;
      try {
        parsed = url ? new URL(expand(url)) : undefined;
      } catch {
        parsed = undefined;
      }
      if (parsed?.protocol !== 'https:') {
        skip('Remote servers need an https URL');
        continue;
      }
      if (definition.headersHelper) {
        skip('headersHelper runs a command on the host: not supported');
        continue;
      }
      planned.push({
        ...base,
        slug: serverSlug(plugin, key, taken),
        transport: 'http',
        url: parsed.toString(),
        headers: record(definition.headers),
      });
      continue;
    }
    if (type !== 'stdio') {
      skip(`Unknown transport ${type}`);
      continue;
    }
    const command = str(definition.command);
    if (!command) {
      skip('No command');
      continue;
    }
    const args = strings(definition.args).map(expand);
    const env = record(definition.env);
    if (strict && (env.PLUGIN_ROOT !== undefined || env.PLUGIN_DATA !== undefined)) {
      skip('Its env may not set PLUGIN_ROOT or PLUGIN_DATA');
      continue;
    }
    const cwdRaw = str(definition.cwd);
    const cwd = cwdRaw
      ? expand(cwdRaw.startsWith('./') ? `${CONTAINER_ROOT}/${cwdRaw.slice(2)}` : cwdRaw)
      : null;
    if (cwd && !cwd.startsWith(`${CONTAINER_ROOT}`) && !cwd.startsWith(CONTAINER_DATA)) {
      skip('Its cwd is outside the plugin');
      continue;
    }
    const mapped = mapCommand(expand(command), args, files);
    if ('skip' in mapped) {
      skip(mapped.skip);
      continue;
    }
    planned.push({ ...base, slug: serverSlug(plugin, key, taken), transport: 'stdio', ...mapped, cwd, env });
  }
  return planned;
}

/** A stdio command, as something superagent runs: the plugin's own files, or an npm or PyPI package. */
function mapCommand(
  command: string,
  args: string[],
  files: Map<string, PluginFile>,
): Pick<PlannedServer, 'runtime' | 'package' | 'version' | 'bin' | 'command'> | { skip: string } {
  const bundled = (argv: string[]) => ({
    runtime: 'bundled' as const,
    package: null,
    version: null,
    bin: null,
    command: argv,
  });
  if (['node', 'python', 'python3', 'sh', 'bash'].includes(command)) {
    return bundled([command === 'python' ? 'python3' : command, ...args]);
  }
  const local = command.startsWith('./')
    ? command.slice(2)
    : command.startsWith(`${CONTAINER_ROOT}/`)
      ? command.slice(CONTAINER_ROOT.length + 1)
      : undefined;
  if (local !== undefined) {
    if (!files.has(local)) return { skip: `Its command ${command} is not in the plugin` };
    return bundled([`${CONTAINER_ROOT}/${local}`, ...args]);
  }
  if (command === 'npx') {
    const rest = [...args];
    let pkg: string | undefined;
    let bin: string | undefined;
    while (rest.length > 0) {
      const arg = rest[0] as string;
      if (arg === '-y' || arg === '--yes' || arg === '-q' || arg === '--quiet') rest.shift();
      else if (arg === '-p' || arg === '--package') {
        rest.shift();
        pkg = rest.shift();
      } else if (arg.startsWith('--package=')) pkg = rest.shift()?.slice('--package='.length);
      else break;
    }
    const first = rest.shift();
    if (!first) return { skip: 'npx with no package' };
    if (pkg) bin = first;
    else pkg = first;
    const at = pkg.lastIndexOf('@');
    const [name, version] = at > 0 ? [pkg.slice(0, at), pkg.slice(at + 1)] : [pkg, 'latest'];
    if (
      !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name) ||
      !/^(?:latest|[0-9A-Za-z][0-9A-Za-z.+_-]*)$/.test(version)
    ) {
      return { skip: `npx package ${pkg} is not one superagent can pin` };
    }
    return { runtime: 'npm', package: name, version, bin: bin ?? null, command: rest };
  }
  if (command === 'uvx') {
    const rest = [...args];
    let from: string | undefined;
    while (rest.length > 0) {
      const arg = rest[0] as string;
      if (arg === '--from') {
        rest.shift();
        from = rest.shift();
      } else if (arg.startsWith('--from=')) from = rest.shift()?.slice('--from='.length);
      else if (arg.startsWith('-')) return { skip: `uvx option ${arg} is not supported` };
      else break;
    }
    const first = rest.shift();
    if (!first) return { skip: 'uvx with no package' };
    const spec = from ?? first;
    if (/[/:]|git\+/.test(spec)) return { skip: `uvx source ${spec} is not a PyPI package` };
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(?:==|@)([0-9A-Za-z][0-9A-Za-z.+_-]*))?$/.exec(spec);
    if (!match) return { skip: `uvx package ${spec} is not one superagent can pin` };
    const binName = from ? first : (match[1] as string);
    return {
      runtime: 'uv',
      package: match[1] as string,
      version: match[2] ?? 'latest',
      bin: binName,
      command: rest,
    };
  }
  if (command === 'docker' || command === 'podman') {
    return { skip: 'Containers of its own: the runner never runs other images' };
  }
  return {
    skip: `The command ${command} is not one superagent runs (node, python, sh, npx, uvx or a file of the plugin)`,
  };
}

/** Fills `${NAME}` and `${NAME:-default}` placeholders from install inputs. */
export function render(template: string, inputs: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    const value = inputs[name];
    if (value !== undefined) return value;
    return fallback ?? whole;
  });
}

/** The input names a template uses. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map((m) => m[1] as string);
}
