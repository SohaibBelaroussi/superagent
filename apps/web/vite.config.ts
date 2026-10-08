import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Writes brotli and gzip copies of the built scripts and styles next to them. The API serves the copy
 * the browser accepts, so it never compresses at request time.
 */
function precompress(): Plugin {
  return {
    name: 'superagent:precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? 'dist';
      for (const name of Object.keys(bundle)) {
        if (!/\.(js|css|svg|html)$/.test(name)) continue;
        const path = join(dir, name);
        const data = readFileSync(path);
        if (data.length < 1024) continue;
        writeFileSync(
          `${path}.br`,
          brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        );
        writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
      }
    },
  };
}

// In development the app runs here and the API on its own port: /v1 (live views are WebSockets)
// and /api are proxied, so the app talks to one origin as it does when the API serves it.
const api = process.env.SUPERAGENT_API_URL ?? 'http://127.0.0.1:4111';

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: api, ws: true },
      '/api': { target: api },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // Libraries change less often than the app: their own chunks stay cached across releases.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            {
              name: 'ui',
              // Not what only pages loaded later use: the autocomplete (and the combobox it builds on)
              // of the command palette, and the checkbox of the organization's forms.
              test: /node_modules[\\/](@base-ui[\\/]react[\\/](?!(autocomplete|combobox|checkbox)[\\/])|@floating-ui|tabbable|use-sync-external-store)/,
            },
            { name: 'data', test: /node_modules[\\/](zod|@tanstack)[\\/]/ },
          ],
        },
      },
    },
  },
});
