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
 * The connection is what is checked, not only the name. Provider requests (`getJson`, every hop
 * of every redirect) and push delivery open their sockets through `publicSocketLookup`, which
 * resolves the name once, refuses the whole answer if any address in it is private, and hands
 * those same addresses to the connection: a name that answers a public address to one query and
 * a private one to the next (DNS rebinding) cannot get a different answer past the check, over
 * plain http or https. An IP literal never reaches a lookup, so `assertPublicUrl` checks it
 * before the socket opens. `assertPublicHost` stays where a person names a host (a Bluesky PDS,
 * a push endpoint), so they hear at once that it is refused; it is not what stops the request.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import type { LookupFunction } from "node:net";

export class BlockedHostError extends Error {
  constructor(host: string, reason: string) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = "BlockedHostError";
  }
}

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
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
  const cleaned = addr.toLowerCase().split("%")[0]!; // split always answers at least one part
  if (net.isIP(cleaned) !== 6) return null;

  // A trailing dotted quad occupies the final two groups.
  let head = cleaned;
  const tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(cleaned);
  if (dotted) {
    const quad = dotted[1]!; // the group is not optional, so a match always carries it
    const octets = quad.split(".").map(Number);
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    head = cleaned.slice(0, cleaned.length - quad.length);
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
  if (!g) return true; // otherwise exactly eight groups, so every index below is present

  const leadingZeros = g.slice(0, 5).every((h) => h === 0);
  // An IPv4 address in IPv6 clothing is still an IPv4 address, however it is spelled.
  const isMapped = leadingZeros && g[5] === 0xffff;
  const isCompatible = leadingZeros && g[5] === 0;
  if (isMapped || isCompatible) {
    const hi = g[6]!;
    const lo = g[7]!;
    const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    // ::  and ::1 fall out of this as 0.0.0.0 and 0.0.0.1, both already refused.
    return ipv4IsPrivate(v4);
  }

  const first = g[0]!;
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

export type HostResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: HostResolver = (host) => lookup(host, { all: true, verbatim: true });

/** Resolve once, validate every answer, then hand only those answers to the socket. */
export function publicSocketLookup(resolver: HostResolver = systemResolver): LookupFunction {
  return (host, options, callback) => {
    resolver(unbracket(host)).then((addresses) => {
      if (!addresses.length) throw new BlockedHostError(host, "the name resolved to nothing");
      for (const { address } of addresses) {
        if (!net.isIP(address) || (!privateHostsAllowed() && isPrivateAddress(address))) {
          throw new BlockedHostError(host, "it resolves to a private or reserved address");
        }
      }
      const chosen = options.family ? addresses.filter((a) => a.family === Number(options.family)) : addresses;
      if (!chosen.length) throw new BlockedHostError(host, "no address matched the requested family");
      if (options.all) callback(null, chosen);
      else callback(null, chosen[0]!.address, chosen[0]!.family);
    }).catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), "", 0));
  };
}

/** IP literals bypass Node's lookup callback and must be checked before opening a socket. */
export function assertPublicUrl(url: string): void {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new BlockedHostError(target.hostname, "only http and https are supported");
  if (target.username || target.password) throw new BlockedHostError(target.hostname, "credentials in URLs are not supported");
  const host = unbracket(target.hostname);
  if (!privateHostsAllowed() && net.isIP(host) && isPrivateAddress(host)) {
    throw new BlockedHostError(host, "it is a private or reserved address");
  }
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
