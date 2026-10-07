/**
 * Which addresses count as the public internet. Shared by the API's URL checks (D25) and the egress
 * proxy that browsers and page fetchers go out through (D34), so both refuse the same things: private
 * and local networks, the tailnet's CGNAT range, cloud metadata, multicast and reserved space.
 */

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
  let text = ip.toLowerCase().replace(/%.*$/, '');
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

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Whether a host is an IP literal (v4, or v6 with or without brackets). */
export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return IPV4.test(bare) || (bare.includes(':') && ipv6Groups(bare) !== undefined);
}

/** True for any address that isn't on the public internet. Anything unparseable counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (IPV4.test(bare)) return isPrivateIPv4(bare);
  if (bare.includes(':')) return isPrivateIPv6(bare);
  return true;
}

/** Names that only mean something inside a network. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/**
 * A host name that can't be a public site: single-label names (postgres, api, localhost) and the
 * internal suffixes. Trailing dots don't change the host ("postgres." is postgres).
 */
export function isInternalHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return !name.includes('.') || INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
