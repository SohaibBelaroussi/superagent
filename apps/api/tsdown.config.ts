import { defineConfig } from 'tsdown';

// Production bundle of the API. `dependencies` stay external and are installed by `pnpm deploy`;
// devDependencies such as @superagent/shared (TypeScript source) are bundled in.
export default defineConfig({
  // The workers ship as their own files next to main.mjs.
  entry: {
    main: 'src/main.ts',
    'extract.worker': 'src/modules/knowledge/extract.worker.ts',
    // Plugin archives are unpacked in a worker too.
    'archive.worker': 'src/modules/capabilities/plugins/archive.worker.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
});
