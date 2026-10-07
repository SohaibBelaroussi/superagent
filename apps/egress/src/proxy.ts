import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { isInternalHostname, isIpLiteral, isPrivateAddress } from '@superagent/shared/net';

/**
 * The forward proxy that browsers and the page fetcher reach the internet through (decision D34).
 * They sit on internal networks with no other way out, so whatever a page does (scripts, redirects,
 * subresources, WebSockets), it reaches public addresses only: each name is resolved here and the
 * address checked is the one dialled, so DNS can't switch it in between.
 */
export interface EgressOptions {
  /** Ports CONNECT may reach (TLS, WebSockets over TLS). */
  connectPorts: ReadonlySet<number>;
  /** Ports plain-http requests may reach. */
  httpPorts: ReadonlySet<number>;
  resolve?: (host: string) => Promise<string[]>;
  /** Which addresses are refused; tests widen what counts as public. */
  isBlocked?: (ip: string) => boolean;
  log?: (event: Record<string, unknown>) => void;
  connectTimeoutMs?: number;
  /** A tunnel with no traffic for this long is closed. */
  idleTimeoutMs?: number;
}

class Refused extends Error {}

const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** The headers meant for the far end: hop-by-hop ones and any the Connection header names go. */
function endToEnd(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const copy = { ...headers };
  for (const name of [...HOP_BY_HOP, ...named]) delete copy[name];
  return copy;
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export function createEgressProxy(options: EgressOptions): http.Server {
  const resolve = options.resolve ?? defaultResolve;
  const isBlocked = options.isBlocked ?? isPrivateAddress;
  const log = options.log ?? (() => {});
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;

  /** One address to dial for a host, if every address it has is public. */
  async function publicAddress(rawHost: string): Promise<string> {
    const host = rawHost.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host) throw new Refused('no host');
    if (isIpLiteral(host)) {
      if (isBlocked(host)) throw new Refused(`private address ${host}`);
      return host;
    }
    if (isInternalHostname(host)) throw new Refused(`internal name ${host}`);
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      throw new Refused(`cannot resolve ${host}`);
    }
    if (addresses.length === 0) throw new Refused(`no address for ${host}`);
    const blocked = addresses.find((address) => isBlocked(address));
    if (blocked) throw new Refused(`${host} resolves to a private address (${blocked})`);
    return addresses[0] as string;
  }

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      // Only proxy requests (absolute URLs): never a reverse proxy for whatever reaches this port.
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Refused(`scheme ${target.protocol}`);
      const port = Number(target.port || 80);
      if (!options.httpPorts.has(port)) throw new Refused(`port ${port}`);
      const address = await publicAddress(target.hostname);
      log({ action: 'allow', kind: 'http', host: target.hostname, address, port });
      const upstream = http.request(
        {
          host: address,
          port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...endToEnd(req.headers), host: target.host },
          setHost: false,
          timeout: connectTimeoutMs,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
          response.pipe(res);
        },
      );
      // Connecting gets connectTimeoutMs; after that, a request idle this long is dropped either way.
      upstream.on('socket', (socket) => socket.once('connect', () => upstream.setTimeout(idleTimeoutMs)));
      req.setTimeout(idleTimeoutMs, () => upstream.destroy(new Error('idle')));
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Upstream failed\n');
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) {
      const reason = error instanceof Refused ? error.message : 'bad request';
      log({ action: 'deny', kind: 'http', url: req.url, reason });
      res.writeHead(error instanceof Refused ? 403 : 400, { 'content-type': 'text/plain' });
      res.end('Blocked by the egress policy: public addresses only\n');
    }
  });

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    try {
      if (!match) throw new Refused(`bad target ${req.url}`);
      const port = Number(match[2]);
      if (!options.connectPorts.has(port)) throw new Refused(`port ${port}`);
      const host = match[1] as string;
      const address = await publicAddress(host);
      log({ action: 'allow', kind: 'connect', host, address, port });
      const upstream = net.connect({ host: address, port, timeout: connectTimeoutMs }, () => {
        upstream.setTimeout(idleTimeoutMs);
        client.setTimeout(idleTimeoutMs);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const close = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.on('timeout', close);
      client.on('timeout', close);
      upstream.on('error', () => {
        if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        else client.destroy();
      });
      client.on('close', () => upstream.destroy());
    } catch (error) {
      const reason = error instanceof Refused ? error.message : 'bad request';
      log({ action: 'deny', kind: 'connect', target: req.url, reason });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });

  return server;
}
