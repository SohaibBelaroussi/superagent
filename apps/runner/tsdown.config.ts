import { defineConfig } from 'tsdown';

// Production bundle of the runner. `dependencies` stay external and are installed by `pnpm deploy`;
// @superagent/shared (TypeScript source, a devDependency) is bundled in.
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
});
