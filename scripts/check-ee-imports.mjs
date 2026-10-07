// Fails when any source file imports Mastra Enterprise Edition code (`@mastra/<pkg>/ee...`).
// Decision D03: EE features need a paid license for real use, so they stay out of this codebase.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const roots = ['apps', 'packages'];
const skipDirs = new Set(['node_modules', 'dist', '.mastra', 'coverage', 'drizzle']);
const exts = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const eeImport = /['"`]@mastra\/[^'"`]*\/ee(?:\/[^'"`]*)?['"`]/;

const hits = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(path);
    } else if (exts.has(extname(entry.name))) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (eeImport.test(line)) hits.push(`${relative(process.cwd(), path)}:${i + 1}: ${line.trim()}`);
        });
    }
  }
}

for (const root of roots) walk(root);

if (hits.length > 0) {
  console.error('Mastra Enterprise (ee) imports are not allowed (decision D03):');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('check:ee ok, no Mastra Enterprise imports');
