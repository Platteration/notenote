import { signIn } from "@/lib/auth";
import { assertSameSite, errorResponse, json, readJson } from "@/lib/api";
import { clearRateLimit, clientKey, rateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/**
 * Throttling password guesses without handing anyone an account-lockout weapon.
 *
 * A limit keyed on the account alone would let an attacker lock a real user out from any
 * address with a handful of wrong guesses. So the strict limit is keyed on the account
 * *and* the address, which stops the ordinary case, and a much looser account-wide ceiling
 * catches a distributed attack without being reachable by casual abuse.
 *
 * The address is only known when a trusted proxy supplies it (TRUSTED_PROXY_HOPS); without
 * one the account-wide ceiling is the whole defence, which is why it exists.
 *
 * Checking the password before the limit is not an option either: scrypt is deliberately
 * expensive, so that would turn this endpoint into a CPU exhaustion vector.
 */
const PER_IP = { limit: 20, windowMs: 15 * 60_000 };
const PER_ACCOUNT_IP = { limit: 8, windowMs: 15 * 60_000 };
const PER_ACCOUNT = { limit: 100, windowMs: 15 * 60_000 };

function tooMany(results: RateLimitResult[]): Response | null {
  const blocked = results.filter((c) => !c.ok);
  if (blocked.length === 0) return null;
  const retryAfter = Math.max(...blocked.map((c) => c.retryAfter));
  return json(
    { error: "Too many sign-in attempts. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

export async function POST(req: Request) {
  try {
    assertSameSite(req);

    // Null when no trusted proxy names the client; the address-keyed buckets are then
    // skipped rather than collapsed onto one shared key, which would be a lockout weapon.
    const ip = clientKey(req);
    // The address-keyed limit runs before the body is read, so a client that is already over
    // it cannot make the server buffer and parse anything at all. The account-keyed limits
    // need the email out of the body, so they necessarily come after it.
    const byAddress = ip ? tooMany([rateLimit(`login:ip:${ip}`, PER_IP.limit, PER_IP.windowMs)]) : null;
    if (byAddress) return byAddress;

    const body = await readJson<{ email?: string; password?: string }>(req);
    const email = (body.email ?? "").trim().toLowerCase();

    const checks: RateLimitResult[] = [];
    if (email) {
      if (ip) checks.push(rateLimit(`login:acct-ip:${email}:${ip}`, PER_ACCOUNT_IP.limit, PER_ACCOUNT_IP.windowMs));
      checks.push(rateLimit(`login:acct:${email}`, PER_ACCOUNT.limit, PER_ACCOUNT.windowMs));
    }
    const byAccount = tooMany(checks);
    if (byAccount) return byAccount;

    const user = await signIn(email, body.password ?? "");
    // A correct password clears this device's bucket for this account, so a burst of typos
    // doesn't linger. The shared per-address bucket is deliberately left alone: clearing it
    // would let anyone with an account of their own reset it between guesses at someone else's.
    if (ip) clearRateLimit(`login:acct-ip:${email}:${ip}`);
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    return errorResponse(err, 401);
  }
}
