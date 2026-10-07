import { isIP } from 'node:net';
import { truncate } from '../../util/text';

export interface WebToolsConfig {
  searxngUrl: string;
  crawl4aiUrl: string;
  crawl4aiToken?: string;
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

const PRIVATE_V4 = [
  [0x0a000000, 8], // 10.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local, cloud metadata)
  [0x64400000, 10], // 100.64.0.0/10 (carrier-grade NAT, includes Tailscale)
  [0x00000000, 8], // 0.0.0.0/8
] as const;

function isPrivateIPv4(ip: string): boolean {
  const n = ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')) return true;
  // IPv4-mapped addresses: URL parsing normalizes ::ffff:10.0.0.1 to hex (::ffff:a00:1).
  const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return isPrivateIPv4(dotted[1]);
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIPv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
  }
  return false;
}

/**
 * Agents read untrusted web content, so a prompt-injected agent could try to reach internal services
 * (Postgres, the API itself, cloud metadata, tailnet devices). Only public http(s) hosts are allowed.
 * DNS rebinding is out of scope here; the browser and sandbox milestones add network isolation.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Only http and https URLs can be fetched (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    (family === 0 && !host.includes('.')) ||
    (family === 4 && isPrivateIPv4(host)) ||
    (family === 6 && isPrivateIPv6(host))
  ) {
    throw new BlockedUrlError(`Refusing to fetch an internal or private address: ${url.host}`);
  }
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
    signal: options.signal ?? AbortSignal.timeout(20_000),
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
  const target = assertPublicUrl(rawUrl);
  const response = await fetch(new URL('/md', config.crawl4aiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.crawl4aiToken ? { authorization: `Bearer ${config.crawl4aiToken}` } : {}),
    },
    body: JSON.stringify({ url: target.toString(), f: 'fit' }),
    signal: options.signal ?? AbortSignal.timeout(60_000),
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
