import net from "node:net";

/**
 * A small fixed-window rate limiter held in memory.
 *
 * Sized for a single-process deployment, which is what the SQLite storage already implies.
 * Behind more than one instance this becomes per-instance and the real limit is the sum, so
 * a shared store (or a reverse proxy limit) is the right answer at that point.
 */
export interface RateLimitResult {
  ok: boolean;
  /** Attempts left in the current window. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
/** Distinct unauthenticated account strings must not grow process state indefinitely. */
export const MAX_RATE_LIMIT_BUCKETS = 10_000;
let lastSweep = 0;

/** Drop expired buckets occasionally; the cardinality cap also covers sustained new keys. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const pool of pools.values()) {
    for (const [key, bucket] of pool) {
      if (bucket.resetAt <= now) pool.delete(key);
    }
  }
}

export function rateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitResult {
  sweep(now);
  const buckets = poolFor(key);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.delete(key);
    if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) buckets.delete(buckets.keys().next().value!);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  // Recently used limits survive pressure; admitting a new key never globally locks sign-in.
  buckets.delete(key);
  buckets.set(key, bucket);
  bucket.count++;
  const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
  if (bucket.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - bucket.count, retryAfter };
}

/** Charge an existing account hint without retaining a new caller-chosen key. */
export function rateLimitIfTracked(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitResult | null {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return null;
  return rateLimit(key, limit, windowMs, now);
}

/**
 * Give an attempt back, for a request that turned out to do nothing.
 *
 * This is how a bucket is charged for what a request *achieved* rather than for having been
 * made, and the charge still has to happen on the way *in*. Reading the bucket on the way in and
 * charging it on the way out looks equivalent and is not: the two are separated by an await, so
 * every request that arrives while the first is hashing reads the same unspent bucket and the
 * ceiling holds only for strictly sequential traffic — 260 concurrent sign-ups created 260
 * accounts against a ceiling of 200. Charging on entry reserves the place; refunding releases it
 * when nothing came of the request, within the same window.
 */
export function refundRateLimit(key: string, now: number = Date.now()): void {
  const bucket = poolFor(key).get(key);
  // A window that has already reset owes nothing: the attempt being refunded is not in it.
  if (!bucket || bucket.resetAt <= now) return;
  bucket.count = Math.max(0, bucket.count - 1);
}

/** Forget a key, e.g. after a successful sign-in, so one bad guess doesn't linger. */
export function clearRateLimit(key: string): void {
  poolFor(key).delete(key);
}

/** Only for tests. */
export function resetAllRateLimits(): void {
  pools.clear();
  lastSweep = 0;
}

/** Only for tests: verify retained state rather than guessing from process memory. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

/**
 * How many reverse proxies in front of this app rewrite `X-Forwarded-For`.
 *
 * There is no way to read the socket address from a route handler, so the only client
 * identity available is a header — and a header is whatever the client says unless a proxy
 * is known to be rewriting it. Default 0, meaning no proxy is trusted.
 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function asAddress(entry: string): string | null {
  const bare = entry.startsWith("[") ? entry.slice(1).split("]")[0]! : entry.split(":").length === 2 ? entry.split(":")[0]! : entry;
  return net.isIP(entry) ? entry : net.isIP(bare) ? bare : null;
}

/**
 * The client's address, or null when this deployment cannot know it.
 *
 * Both halves of this matter. Trusting `X-Forwarded-For` from a direct client lets anyone
 * pick a fresh bucket per request, which makes every per-address limit decorative. Falling
 * back to a constant when there is no proxy is worse: every client then shares one bucket,
 * so twenty wrong sign-ins from a stranger would lock sign-in for the whole deployment.
 * Neither is acceptable, so an unidentifiable client gets no address at all and callers skip
 * the address-keyed buckets rather than sharing one.
 */
export function clientKey(req: Request, env: Record<string, string | undefined> = process.env): string | null {
  const hops = trustedProxyHops(env);
  if (hops === 0) return null;
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // The rightmost entry was written by the nearest proxy, so the client is `hops` from the
  // right. A shorter chain than that means the header did not come from where it should.
  const entry = chain.length >= hops ? chain[chain.length - hops] : undefined;
  return entry ? asAddress(entry) : null;
}
