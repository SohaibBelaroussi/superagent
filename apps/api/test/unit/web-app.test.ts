import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { noopLogger } from '@mastra/core/logger';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/http/types';
import { serveWebApp, WEB_CSP } from '../../src/http/web';

const PAGE = '<!doctype html><html><head><script src="/theme.js"></script></head><body></body></html>';
const SCRIPT = `console.log(${'"superagent "'.repeat(200)});`;

const SECRET = 'top secret, outside the build';

let root: string;
let dir: string;
let app: Hono<AppEnv>;

/**
 * A built app in a folder, a secret file next to that folder (what a path traversal would be after),
 * and an API in front of the app with one route and problem+json 404s.
 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'web-app-'));
  dir = join(root, 'web');
  writeFileSync(join(root, 'SECRET'), SECRET);
  mkdirSync(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), PAGE);
  writeFileSync(join(dir, 'theme.js'), '/* theme */');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), SCRIPT);
  writeFileSync(join(dir, 'assets', 'index-abc123.js.br'), brotliCompressSync(SCRIPT));
  writeFileSync(join(dir, 'assets', 'index-abc123.js.gz'), gzipSync(SCRIPT));
  writeFileSync(join(dir, 'assets', 'font-def456.woff2'), 'woff2');

  app = new Hono<AppEnv>();
  app.notFound((c) => c.json({ code: 'not_found' }, 404, { 'content-type': 'application/problem+json' }));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/v1/board', (c) => c.json({ columns: [] }));
  expect(serveWebApp(app, dir, noopLogger)).toBe(true);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the web app on the API origin', () => {
  it('answers page paths with index.html under a strict CSP', async () => {
    for (const path of ['/', '/board', '/tasks/0199b1a2-3c4d', '/sign-in']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(PAGE);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toBe(WEB_CSP);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    expect(WEB_CSP).toContain("script-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).not.toContain('unsafe-inline');
  });

  it('serves hashed assets for good, compressed the way the browser accepts', async () => {
    const br = await app.request('/assets/index-abc123.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(br.status).toBe(200);
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(br.headers.get('vary')).toBe('accept-encoding');
    expect(br.headers.get('content-type')).toContain('text/javascript');
    expect(Buffer.from(await br.arrayBuffer())).toEqual(brotliCompressSync(SCRIPT));

    const gz = await app.request('/assets/index-abc123.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');

    const plain = await app.request('/assets/index-abc123.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(SCRIPT);

    const font = await app.request('/assets/font-def456.woff2', { headers: { 'accept-encoding': 'br' } });
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('content-encoding')).toBeNull();
  });

  it('serves the root files without caching them', async () => {
    const res = await app.request('/theme.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('/* theme */');
  });

  it('answers HEAD without a body', async () => {
    const res = await app.request('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(PAGE)));
    expect(await res.text()).toBe('');
  });

  it('leaves the API alone: its routes and its 404s', async () => {
    expect(await (await app.request('/v1/board')).json()).toEqual({ columns: [] });
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok' });
    for (const path of ['/v1/nothing-here', '/api/nothing-here', '/v1', '/api']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('problem+json');
    }
    expect((await app.request('/board', { method: 'POST' })).status).toBe(404);
  });

  it('serves only files of the build: missing files are 404s', async () => {
    for (const path of ['/assets/missing.js', '/favicon.ico', '/secret.env', '/assets/index-abc123.js.br']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('never reaches a file outside the build, however the path is written', async () => {
    // Extensionless, so the file-extension rule can't be what stops them: a path naming no file of the
    // build gets the app's page, never the file next to the build.
    for (const path of [
      '/../SECRET',
      '/..%2fSECRET',
      '/%2e%2e/SECRET',
      '/%2e%2e%2fSECRET',
      '/assets/..%2f..%2fSECRET',
      '/assets/%2e%2e/%2e%2e/SECRET',
      '/assets%2f..%2f..%2fSECRET',
      '/web/../SECRET',
    ]) {
      const res = await app.request(path);
      const body = await res.text();
      expect(body, path).not.toContain(SECRET);
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) expect(body, path).toBe(PAGE);
    }
  });

  it('serves nothing without a build', () => {
    const empty = mkdtempSync(join(tmpdir(), 'web-empty-'));
    try {
      const bare = new Hono<AppEnv>();
      expect(serveWebApp(bare, empty, noopLogger)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
