import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Development convenience: loads the nearest .env walking up from `start` to the repo root.
 * Variables already set in the environment win. Production (Docker) gets its env from compose.
 */
export function loadDotEnv(start = process.cwd()): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  let dir = start;
  for (;;) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
