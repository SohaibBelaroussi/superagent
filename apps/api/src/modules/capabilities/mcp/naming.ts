import { createHash } from 'node:crypto';

const MAX = 64;
const SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * Slugs an MCP server may not take: the first word of every built-in tool's name (catalog, lead and
 * chief tools, skills, browser and workspace tools). A tool's name is `<slug>_<tool>` and slugs have no
 * underscore, so no MCP tool can then take a built-in's name. A new built-in tool adds its first word
 * here (a unit test checks them).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'add',
  'board',
  'browser',
  'cancel',
  'create',
  'current',
  'fetch',
  'inspect',
  'knowledge',
  'mastra',
  'message',
  'report',
  'skill',
  'update',
  'web',
]);

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 6);

/**
 * The names agents see for a server's tools: `<slug>_<tool>`, within what OpenAI-compatible APIs take
 * (`[A-Za-z0-9_-]{1,64}`). Tools whose names need no change get them first; a name that had to be
 * cut or changed, and clashes, gets a short hash of the tool's real name. The same tools always get
 * the same names.
 */
export function mcpToolKeys(slug: string, tools: string[]): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>();
  const exact = (tool: string) => SAFE.test(tool) && `${slug}_${tool}`.length <= MAX;
  const ordered = [...tools].sort((a, b) => Number(exact(b)) - Number(exact(a)) || a.localeCompare(b));
  for (const tool of ordered) {
    const plain = `${slug}_${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const hashed = `${plain.slice(0, MAX - 7)}_${shortHash(tool)}`;
    let key = plain.length <= MAX ? plain : hashed;
    if (taken.has(key)) key = hashed;
    taken.add(key);
    keys.set(tool, key);
  }
  return keys;
}
