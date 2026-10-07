import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedUrlError } from '../../src/modules/tools/web';

/** Fake DNS: public names resolve to public IPs, a few names point at private ones. */
const DNS: Record<string, string[]> = {
  'example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'sub.domain.co.uk': ['151.101.0.81'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'localtest.me': ['127.0.0.1', '::1'],
  'tailnet-box.example.ts.net': ['100.101.128.106'],
  'mixed.example.com': ['93.184.215.14', '10.0.0.7'],
};
const resolveHost = async (host: string) => {
  const addresses = DNS[host];
  if (!addresses) throw new Error(`ENOTFOUND ${host}`);
  return addresses;
};

describe('assertPublicUrl', () => {
  it.each([
    'https://example.com/page',
    'https://example.com./page', // trailing dot, same host
    'http://8.8.8.8/',
    'https://172.32.0.1/', // just outside 172.16.0.0/12
    'https://sub.domain.co.uk/a?b=c',
    'http://[2606:4700:4700::1111]/', // public IPv6
    'http://[::ffff:8.8.8.8]/', // IPv4-mapped public
    'http://[64:ff9b::808:808]/', // NAT64 of a public IPv4
  ])('allows public URL %s', async (url) => {
    expect((await assertPublicUrl(url, resolveHost)).toString()).toBe(new URL(url).toString());
  });

  it.each([
    ['http://localhost:4111/v1/me', 'loopback name'],
    ['http://localhost./', 'loopback name with a trailing dot'],
    ['http://localhost%2e:11235/', 'encoded trailing dot'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://0x7f.1/', 'loopback in hex'],
    ['http://2130706433/', 'loopback as a number'],
    ['http://10.1.2.3/', 'private 10/8'],
    ['http://172.20.0.5:5432/', 'private 172.16/12 (docker networks)'],
    ['http://192.168.1.1/', 'private 192.168/16'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['http://100.101.128.106/', 'tailnet (CGNAT)'],
    ['http://192.0.0.8/', 'IETF protocol assignments'],
    ['http://198.18.0.1/', 'benchmarking'],
    ['http://224.0.0.1/', 'multicast'],
    ['http://240.0.0.1/', 'reserved'],
    ['http://255.255.255.255/', 'broadcast'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::]/', 'IPv6 unspecified'],
    ['http://[fd00::1]/', 'IPv6 unique local'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fea0::1]/', 'IPv6 link-local, upper part of fe80::/10'],
    ['http://[fec0::1]/', 'IPv6 site-local'],
    ['http://[ff02::1]/', 'IPv6 multicast'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped private'],
    ['http://[::127.0.0.1]/', 'IPv4-compatible loopback'],
    ['http://[64:ff9b::a00:1]/', 'NAT64 of a private IPv4'],
    ['http://[2002:a00:1::1]/', '6to4 of a private IPv4'],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'Teredo'],
    ['http://postgres:5432/', 'single-label service name'],
    ['http://postgres.:5432/', 'service name with a trailing dot'],
    ['http://api.internal/', '.internal'],
    ['http://host.docker.internal./', '.internal with a trailing dot'],
    ['http://printer.local/', '.local'],
    ['http://router.home.arpa/', '.home.arpa'],
    ['http://127.0.0.1.nip.io/', 'a name that resolves to loopback'],
    ['http://localtest.me/', 'a name that resolves to loopback'],
    ['http://tailnet-box.example.ts.net/', 'a name that resolves into the tailnet'],
    ['http://mixed.example.com/', 'a name with one private address among public ones'],
    ['http://does-not-exist.example/', 'a name that does not resolve'],
    ['ftp://example.com/file', 'non-http scheme'],
    ['not a url', 'garbage'],
  ])('blocks %s (%s)', async (url) => {
    await expect(assertPublicUrl(url, resolveHost)).rejects.toThrow(BlockedUrlError);
  });
});

describe('web tools against a fake search and page service', () => {
  it('searches, drops results without URLs, and fetches pages with the service token', async () => {
    const { startFakeWeb } = await import('../support/fake-web');
    const { fetchPage, searchWeb } = await import('../../src/modules/tools/web');
    const web = await startFakeWeb();
    try {
      const config = { searxngUrl: web.url, crawl4aiUrl: web.url, crawl4aiToken: 'token-123', resolveHost };
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
