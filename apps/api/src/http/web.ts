import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Context, Hono } from 'hono';
import type { AppEnv } from './types';

/** The API's own paths: the web app never answers them, so their 404s stay problem+json. */
const API_PATHS = ['/api', '/v1', '/health', '/ready'];

/**
 * The app's pages run scripts, styles, fonts and requests from this origin only, and can't be framed
 * (decision D44). It is what makes keeping the device token in the page's storage acceptable (D45).
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  'content-security-policy': WEB_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

interface WebFile {
  path: string;
  type: string;
  size: number;
  /** Under /assets: named after their content by the build, so they can be cached for good. */
  immutable: boolean;
  /** Compressed copies written by the build next to the file. */
  br?: string;
  gzip?: string;
}

/** A file's bytes as the view Hono sends, without copying them. */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Every file the build produced, by URL path, listed once at boot. Requests are looked up in this map
 * and never joined onto a filesystem path, so nothing outside the build can be reached.
 */
function catalog(dir: string): Map<string, WebFile> {
  const files = new Map<string, WebFile>();
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.br') || entry.name.endsWith('.gz')) continue;
      files.set(`/${prefix}${entry.name}`, {
        path,
        type: TYPES[extname(entry.name)] ?? 'application/octet-stream',
        size: statSync(path).size,
        immutable: prefix.startsWith('assets/'),
        br: existsSync(`${path}.br`) ? `${path}.br` : undefined,
        gzip: existsSync(`${path}.gz`) ? `${path}.gz` : undefined,
      });
    }
  };
  walk(dir, '');
  return files;
}

/**
 * Serves the built web app from `dir` on the API's origin (decision D44): its files as they are, and
 * index.html for every other page path. Registered after the API's routes, it answers only what they
 * didn't, and never the API's own paths. Returns false (and serves nothing) without a build.
 */
export function serveWebApp(app: Hono<AppEnv>, dir: string, logger: IMastraLogger): boolean {
  if (!existsSync(join(dir, 'index.html'))) {
    logger.warn('No web app build in WEB_DIR: the web app is not served', { dir });
    return false;
  }
  const files = catalog(dir);
  const page = bytes(readFileSync(join(dir, 'index.html')));
  // Small and immutable for the life of the process; source maps are read when asked for.
  const cache = new Map<string, Uint8Array<ArrayBuffer>>();
  const read = (path: string): Uint8Array<ArrayBuffer> => {
    const cached = cache.get(path);
    if (cached) return cached;
    const data = bytes(readFileSync(path));
    if (!path.endsWith('.map')) cache.set(path, data);
    return data;
  };

  const sendFile = (c: Context<AppEnv>, file: WebFile) => {
    const accepts = c.req.header('accept-encoding') ?? '';
    const variant =
      file.br && /\bbr\b/.test(accepts)
        ? { path: file.br, encoding: 'br' }
        : file.gzip && /\bgzip\b/.test(accepts)
          ? { path: file.gzip, encoding: 'gzip' }
          : { path: file.path, encoding: undefined };
    const body = read(variant.path);
    const headers: Record<string, string> = {
      'content-type': file.type,
      'content-length': String(body.length),
      'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      vary: 'accept-encoding',
    };
    if (variant.encoding) headers['content-encoding'] = variant.encoding;
    return c.req.method === 'HEAD' ? c.body(null, 200, headers) : c.body(body, 200, headers);
  };

  app.on(['GET', 'HEAD'], '*', async (c, next) => {
    const path = c.req.path;
    if (API_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next();
    const file = files.get(path);
    if (file && path !== '/index.html') return sendFile(c, file);
    // A path with an extension names a file, and there is no such file: a 404, not the app.
    if (extname(path) && path !== '/index.html') return next();
    const headers = { ...PAGE_HEADERS, 'content-length': String(page.length) };
    return c.req.method === 'HEAD' ? c.body(null, 200, headers) : c.body(page, 200, headers);
  });
  logger.info('Serving the web app', { dir, files: files.size });
  return true;
}
