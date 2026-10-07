import { createHash } from 'node:crypto';

/** Names Mastra gives skills' tools: an MCP tool must never take one. */
const RESERVED = new Set(['skill', 'skill_read', 'skill_search']);
const MAX = 64;
const SAFE = /^[A-Za-z0-9_-]+$/;

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
    if (taken.has(key) || RESERVED.has(key)) key = hashed;
    taken.add(key);
    keys.set(tool, key);
  }
  return keys;
}
