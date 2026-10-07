import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { truncate } from '../../util/text';

/** Resolves a host name to its IP addresses. */
export type ResolveHost = (host: string) => Promise<string[]>;

const resolveWithDns: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export interface WebToolsConfig {
  searxngUrl: string;
  crawl4aiUrl: string;
  crawl4aiToken?: string;
  /** DNS for the private-address check; tests replace it. */
  resolveHost?: ResolveHost;
}

const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 60_000;

/** The run's abort signal (client gone, task cancelled) combined with our own time limit. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

/** Thrown for URLs an agent must not fetch (internal services, private networks). */
export class BlockedUrlError extends Error {
  override name = 'BlockedUrlError';
}

/** IPv4 ranges that aren't the public internet (IANA special-purpose registry, multicast, reserved). */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT, includes Tailscale
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private (docker networks)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

const ipv4Number = (ip: string) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const BLOCKED_V4_RANGES = BLOCKED_V4.map(([base, bits]) => [ipv4Number(base) >>> (32 - bits), bits] as const);

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4Number(ip);
  return BLOCKED_V4_RANGES.some(([prefix, bits]) => n >>> (32 - bits) === prefix);
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it doesn't parse. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g5, g6, g7] = [0, 1, 2, 5, 6, 7].map((i) => g[i] ?? 0) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  // Addresses that carry an IPv4 address are judged by it: mapped (::ffff:a.b.c.d) and compatible
  // (::a.b.c.d, which covers :: and ::1), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
  if (zero(0, 5) && (g5 === 0xffff || g5 === 0)) return isPrivateIPv4(v4(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && zero(2, 6)) return isPrivateIPv4(v4(g6, g7));
  if (g0 === 0x2002) return isPrivateIPv4(v4(g1, g2));
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) || // Teredo (hides an IPv4), documentation
    (g0 === 0x0100 && zero(1, 4)) || // 100::/64 discard
    (g0 === 0x64 && g1 === 0xff9b && g2 === 1) // 64:ff9b:1::/48 local-use NAT64
  );
}

const isPrivateAddress = (ip: string) => (isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip));

/** Names that only mean something inside a network. Single-label names (postgres, api) are refused too. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/**
 * Agents read untrusted web content, so a prompt-injected agent could try to reach internal services
 * (Postgres, the API itself, cloud metadata, tailnet devices). Only public http(s) hosts are allowed:
 * IP literals are checked directly and names are resolved, every address checked.
 *
 * The check runs before the request, so a name that resolves differently later (DNS rebinding) or a
 * redirect is the fetcher's job: Crawl4AI pins the resolved IP and re-checks every hop. A tool that
 * fetches directly must do the same (manual redirects, each hop through this function).
 */
export async function assertPublicUrl(raw: string, resolveHost: ResolveHost = resolveWithDns): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Only http and https URLs can be fetched (got ${url.protocol})`);
  }
  // "postgres." and "localhost." are the same hosts as without the trailing dot.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const refuse = () => new BlockedUrlError(`Refusing to fetch an internal or private address: ${url.host}`);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw refuse();
    return url;
  }
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw refuse();
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw refuse();
  return url;
}

/** Searches the web through the private SearXNG instance. */
export async function searchWeb(
  config: WebToolsConfig,
  query: string,
  options: { limit: number; signal?: AbortSignal },
): Promise<SearchResult[]> {
  const url = new URL('/search', config.searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: withTimeout(options.signal, SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Search failed: the search service returned ${response.status}`);
  const body = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; engine?: string }>;
  };
  return (body.results ?? [])
    .filter((r): r is typeof r & { url: string } => typeof r.url === 'string' && r.url.length > 0)
    .slice(0, options.limit)
    .map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      snippet: truncate((r.content ?? '').trim(), 300),
      engine: r.engine,
    }));
}

/** Fetches a public page through Crawl4AI and returns readable markdown. */
export async function fetchPage(
  config: WebToolsConfig,
  rawUrl: string,
  options: { maxChars: number; signal?: AbortSignal },
): Promise<{ url: string; markdown: string; truncated: boolean }> {
  const target = await assertPublicUrl(rawUrl, config.resolveHost);
  const response = await fetch(new URL('/md', config.crawl4aiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.crawl4aiToken ? { authorization: `Bearer ${config.crawl4aiToken}` } : {}),
    },
    body: JSON.stringify({ url: target.toString(), f: 'fit' }),
    signal: withTimeout(options.signal, FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Fetch failed: the page service returned ${response.status}`);
  const body = (await response.json()) as { markdown?: string; success?: boolean };
  if (body.success === false || !body.markdown?.trim()) {
    throw new Error(`Could not extract readable content from ${target.toString()}`);
  }
  const markdown = body.markdown.trim();
  return {
    url: target.toString(),
    markdown: markdown.slice(0, options.maxChars),
    truncated: markdown.length > options.maxChars,
  };
}
