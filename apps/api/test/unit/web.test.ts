import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedUrlError } from '../../src/modules/tools/web';

describe('assertPublicUrl', () => {
  it.each([
    'https://example.com/page',
    'http://8.8.8.8/',
    'https://172.32.0.1/', // just outside 172.16.0.0/12
    'https://sub.domain.co.uk/a?b=c',
  ])('allows public URL %s', (url) => {
    expect(assertPublicUrl(url).toString()).toBe(new URL(url).toString());
  });

  it.each([
    ['http://localhost:4111/v1/me', 'loopback name'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://10.1.2.3/', 'private 10/8'],
    ['http://172.20.0.5:5432/', 'private 172.16/12 (docker networks)'],
    ['http://192.168.1.1/', 'private 192.168/16'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['http://100.101.128.106/', 'tailnet (CGNAT)'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fd00::1]/', 'IPv6 unique local'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped private'],
    ['http://postgres:5432/', 'single-label service name'],
    ['http://api.internal/', '.internal'],
    ['ftp://example.com/file', 'non-http scheme'],
    ['not a url', 'garbage'],
  ])('blocks %s (%s)', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(BlockedUrlError);
  });
});

describe('web tools against a fake search and page service', () => {
  it('searches, drops results without URLs, and fetches pages with the service token', async () => {
    const { startFakeWeb } = await import('../support/fake-web');
    const { fetchPage, searchWeb } = await import('../../src/modules/tools/web');
    const web = await startFakeWeb();
    try {
      const config = { searxngUrl: web.url, crawl4aiUrl: web.url, crawl4aiToken: 'token-123' };
      const results = await searchWeb(config, 'mastra', { limit: 5 });
      expect(results.map((r) => r.url)).toEqual([
        'https://mastra.ai/docs',
        'https://github.com/mastra-ai/mastra',
      ]);

      const page = await fetchPage(config, 'https://example.com/a', { maxChars: 12 });
      expect(page).toMatchObject({ url: 'https://example.com/a', truncated: true });
      expect(page.markdown).toHaveLength(12);
      expect(web.fetches).toEqual([{ url: 'https://example.com/a', authorization: 'Bearer token-123' }]);

      await expect(fetchPage(config, 'http://postgres:5432/', { maxChars: 100 })).rejects.toThrow(
        BlockedUrlError,
      );
      expect(web.fetches).toHaveLength(1);
    } finally {
      await web.close();
    }
  });
});
