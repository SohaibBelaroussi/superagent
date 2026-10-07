import { defineConfig } from 'tsdown';

// Production bundle of the API. `dependencies` stay external and are installed by `pnpm deploy`;
// devDependencies such as @superagent/shared (TypeScript source) are bundled in.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
});
