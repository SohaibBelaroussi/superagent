import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isInternalHostname, isPrivateAddress } from '@superagent/shared/net';
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
  if (isInternalHostname(host)) throw refuse();
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
