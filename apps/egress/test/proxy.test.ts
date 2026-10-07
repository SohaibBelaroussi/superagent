import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { isPrivateAddress } from '@superagent/shared/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEgressProxy } from '../src/proxy';

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

/** Sends a raw request to the proxy and returns the first line of the answer (and the rest). */
function raw(port: number, request: string, after?: (socket: net.Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n') && after) {
        after(socket);
        after = undefined;
      }
    });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 3_000);
  });
}

describe('egress proxy', () => {
  const upstream = http.createServer((req, res) => res.end(`hello from ${req.headers.host}${req.url}`));
  const echo = net.createServer((socket) => socket.pipe(socket));
  const names: Record<string, string[]> = {
    'public.example': ['127.0.0.1'],
    'sneaky.example': ['93.184.216.34', '10.0.0.5'],
    'private.example': ['169.254.169.254'],
  };
  const resolve = async (host: string) => {
    const found = names[host];
    if (!found) throw new Error('NXDOMAIN');
    return found;
  };
  const events: Array<Record<string, unknown>> = [];
  let upstreamPort = 0;
  let echoPort = 0;
  // Strict: the real policy. Lenient: loopback counts as public, so the allow path can be exercised locally.
  let strictPort = 0;
  let lenientPort = 0;
  let strict: http.Server;
  let lenient: http.Server;

  beforeAll(async () => {
    upstreamPort = await listen(upstream);
    echoPort = await listen(echo);
    strict = createEgressProxy({
      connectPorts: new Set([443, echoPort]),
      httpPorts: new Set([80, upstreamPort]),
      resolve,
      log: (e) => events.push(e),
    });
    lenient = createEgressProxy({
      connectPorts: new Set([echoPort]),
      httpPorts: new Set([upstreamPort]),
      resolve,
      isBlocked: (ip) => ip !== '127.0.0.1' && isPrivateAddress(ip),
    });
    strictPort = await listen(strict);
    lenientPort = await listen(lenient);
  });

  afterAll(() => {
    for (const server of [upstream, echo, strict, lenient]) server.close();
  });

  it('forwards plain http to a public address, with the Host it was asked for', async () => {
    const answer = await raw(
      lenientPort,
      `GET http://public.example:${upstreamPort}/page?x=1 HTTP/1.1\r\nHost: public.example:${upstreamPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(answer).toContain(`hello from public.example:${upstreamPort}/page?x=1`);
  });

  it('tunnels CONNECT to a public address', async () => {
    const answer = await raw(
      lenientPort,
      `CONNECT public.example:${echoPort} HTTP/1.1\r\nHost: public.example:${echoPort}\r\n\r\n`,
      (socket) => socket.write('ping'),
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(answer.endsWith('ping')).toBe(true);
  });

  it('refuses private addresses, internal names and names that resolve to them', async () => {
    const refused = [
      `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`,
      `CONNECT 10.1.2.3:443 HTTP/1.1\r\n\r\n`,
      `CONNECT [::1]:443 HTTP/1.1\r\n\r\n`,
      `CONNECT [::ffff:192.168.1.1]:443 HTTP/1.1\r\n\r\n`,
      `CONNECT 100.100.100.100:443 HTTP/1.1\r\n\r\n`,
      `CONNECT postgres:443 HTTP/1.1\r\n\r\n`,
      `CONNECT host.docker.internal:443 HTTP/1.1\r\n\r\n`,
      `CONNECT private.example:443 HTTP/1.1\r\n\r\n`,
      // Any private record refuses the name: DNS can't pick the bad one later.
      `CONNECT sneaky.example:443 HTTP/1.1\r\n\r\n`,
      `CONNECT nowhere.example:443 HTTP/1.1\r\n\r\n`,
    ];
    for (const request of refused) {
      expect(await raw(strictPort, request), request).toMatch(/^HTTP\/1\.1 403/);
    }
    const http = await raw(
      strictPort,
      `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n`,
    );
    expect(http).toMatch(/^HTTP\/1\.1 403/);
    expect(events.some((e) => e.action === 'deny')).toBe(true);
  });

  it('refuses other ports, other schemes and requests that are not proxy requests', async () => {
    expect(await raw(lenientPort, `CONNECT public.example:22 HTTP/1.1\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
    expect(
      await raw(lenientPort, `GET http://public.example:8080/ HTTP/1.1\r\nHost: public.example:8080\r\n\r\n`),
    ).toMatch(/^HTTP\/1\.1 403/);
    expect(
      await raw(lenientPort, `GET ftp://public.example/ HTTP/1.1\r\nHost: public.example\r\n\r\n`),
    ).toMatch(/^HTTP\/1\.1 403/);
    // Origin-form: someone talking to the proxy as if it were a web server.
    expect(await raw(lenientPort, `GET / HTTP/1.1\r\nHost: egress\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/);
  });
});
