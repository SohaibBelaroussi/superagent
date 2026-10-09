import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('the design tokens', () => {
  it('match the web app’s theme (run `pnpm --filter @superagent/mobile tokens` after changing it)', () => {
    const run = () =>
      execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'tokens.mts'), '--check'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    expect(run).not.toThrow();
  });
});
