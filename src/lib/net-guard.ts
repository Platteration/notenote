/**
 * Guard for outbound requests whose destination a user chose.
 *
 * Almost every platform here has a hard-coded API host, but Bluesky lets people name their
 * own PDS, which is a legitimate need and also a way to point the server at whatever it can
 * reach. Left open, an account holder can probe the internal network — an open port, a closed
 * one and an unroutable address fail differently and at different speeds — and any internal
 * https service with a trusted certificate would have part of its response handed back in the
 * error message.
 *
 * Note the residual risk: this resolves the name and then fetches it, so a host that answers
 * with a public address here and a private one microseconds later (DNS rebinding) is not
 * covered. Closing that needs the resolved address pinned into the connection itself.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class BlockedHostError extends Error {
  constructor(host: string, reason: string) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = "BlockedHostError";
  }
}

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null if it isn't one.
 *
 * Parsing rather than pattern-matching matters here: the URL parser rewrites
 * `::ffff:127.0.0.1` as `::ffff:7f00:1`, so a regex looking for a dotted quad misses an
 * IPv4 loopback address written the other way round.
 */
export function expandIpv6(addr: string): number[] | null {
  const cleaned = addr.toLowerCase().split("%")[0];
  if (net.isIP(cleaned) !== 6) return null;

  // A trailing dotted quad occupies the final two groups.
  let head = cleaned;
  const tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(cleaned);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    head = cleaned.slice(0, cleaned.length - dotted[1].length);
  }

  const [before, after] = head.split("::") as [string, string | undefined];
  const parse = (part: string) => part.split(":").filter(Boolean).map((h) => parseInt(h, 16));
  const left = parse(before);
  const right = after === undefined ? [] : parse(after);
  const groups = after === undefined
    ? [...left, ...tail]
    : [...left, ...Array(8 - left.length - right.length - tail.length).fill(0), ...right, ...tail];

  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function ipv6IsPrivate(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;

  const leadingZeros = g.slice(0, 5).every((h) => h === 0);
  // An IPv4 address in IPv6 clothing is still an IPv4 address, however it is spelled.
  const isMapped = leadingZeros && g[5] === 0xffff;
  const isCompatible = leadingZeros && g[5] === 0;
  if (isMapped || isCompatible) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    // ::  and ::1 fall out of this as 0.0.0.0 and 0.0.0.1, both already refused.
    return ipv4IsPrivate(v4);
  }

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Whether an address is one the server should never be asked to reach on a user's behalf. */
export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true; // not an address at all: refuse rather than guess
}

/**
 * Operators who deliberately run a service on their own network can opt out. It is off by
 * default because the safe choice should not require reading the documentation.
 */
export function privateHostsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALLOW_PRIVATE_PROVIDER_HOSTS === "1";
}

/**
 * URL.hostname keeps the brackets around an IPv6 literal, which would otherwise fail the
 * isIP check and be treated as a name to resolve — blocked, but for the wrong reason, and
 * fragile.
 */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Throw unless every address this host resolves to is publicly routable. */
export async function assertPublicHost(rawHost: string): Promise<void> {
  if (privateHostsAllowed()) return;
  if (!rawHost) throw new BlockedHostError(rawHost, "no host was given");
  const host = unbracket(rawHost);

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedHostError(host, "it is a private or reserved address");
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedHostError(host, "the name could not be resolved");
  }
  if (addresses.length === 0) throw new BlockedHostError(host, "the name resolved to nothing");
  // Every answer must be public: one private address is enough to make this unsafe.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new BlockedHostError(host, "it resolves to a private or reserved address");
  }
}
