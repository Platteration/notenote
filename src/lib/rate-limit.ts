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
let lastSweep = 0;

/** Drop expired buckets occasionally so the map can't grow without bound. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitResult {
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  bucket.count++;
  const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
  if (bucket.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - bucket.count, retryAfter };
}

/** Forget a key, e.g. after a successful sign-in, so one bad guess doesn't linger. */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

/** Only for tests. */
export function resetAllRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

/**
 * Best-effort client identity. Proxy headers are attacker-controlled in general, so this
 * is a throttling aid rather than an authorisation input; it is never used to grant access.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
