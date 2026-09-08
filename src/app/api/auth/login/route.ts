import { signIn } from "@/lib/auth";
import { errorResponse, json, readJson } from "@/lib/api";
import { clearRateLimit, clientKey, rateLimit } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/**
 * Throttling password guesses without handing anyone an account-lockout weapon.
 *
 * A limit keyed on the account alone would let an attacker lock a real user out from any
 * address with a handful of wrong guesses. So the strict limit is keyed on the account
 * *and* the address, which stops the ordinary case, and a much looser account-wide ceiling
 * catches a distributed attack without being reachable by casual abuse.
 *
 * Checking the password before the limit is not an option either: scrypt is deliberately
 * expensive, so that would turn this endpoint into a CPU exhaustion vector.
 */
const PER_IP = { limit: 20, windowMs: 15 * 60_000 };
const PER_ACCOUNT_IP = { limit: 8, windowMs: 15 * 60_000 };
const PER_ACCOUNT = { limit: 100, windowMs: 15 * 60_000 };

export async function POST(req: Request) {
  try {
    const body = await readJson<{ email?: string; password?: string }>(req);
    const email = (body.email ?? "").trim().toLowerCase();

    const ip = clientKey(req);
    const checks = [rateLimit(`login:ip:${ip}`, PER_IP.limit, PER_IP.windowMs)];
    if (email) {
      checks.push(rateLimit(`login:acct-ip:${email}:${ip}`, PER_ACCOUNT_IP.limit, PER_ACCOUNT_IP.windowMs));
      checks.push(rateLimit(`login:acct:${email}`, PER_ACCOUNT.limit, PER_ACCOUNT.windowMs));
    }
    const blocked = checks.filter((c) => !c.ok);
    if (blocked.length > 0) {
      const retryAfter = Math.max(...blocked.map((c) => c.retryAfter));
      return json(
        { error: "Too many sign-in attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const user = await signIn(email, body.password ?? "");
    // A correct password clears this device's buckets, so a burst of typos doesn't linger.
    clearRateLimit(`login:acct-ip:${email}:${ip}`);
    clearRateLimit(`login:ip:${ip}`);
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    return errorResponse(err, 401);
  }
}
