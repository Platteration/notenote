import { MAX_EMAIL_LENGTH, signIn } from "@/lib/auth";
import { assertSameSite, errorResponse, json, readJson } from "@/lib/api";
import { UserFacingError } from "@/lib/errors";
import { clearRateLimit, clientKey, rateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/**
 * Throttling password guesses without handing anyone an account-lockout weapon.
 *
 * A limit keyed on the account alone, refusing the request outright, *is* that weapon: a
 * stranger who knows an address spends the ceiling on wrong guesses and the owner's own correct
 * password is then answered 429 as well — and with no password reset anywhere in this app, for
 * as long as the stranger keeps topping the bucket up. So the strict limit is keyed on the
 * account *and* the address, and the account-wide ceiling is *counted* rather than enforced:
 * past it a guess waits a second and only a wrong one is turned away. A correct password always
 * gets in, and clears the count.
 *
 * The address is only known when a trusted proxy supplies it (TRUSTED_PROXY_HOPS); without one
 * the account-wide ceiling and the concurrency ceiling below are what is left.
 *
 * Checking the password before the limits is not an option either: scrypt is deliberately
 * expensive, so that would turn this endpoint into a CPU exhaustion vector.
 */
const PER_IP = { limit: 20, windowMs: 15 * 60_000 };
const PER_ACCOUNT_IP = { limit: 8, windowMs: 15 * 60_000 };
const PER_ACCOUNT = { limit: 100, windowMs: 15 * 60_000 };

/** What a guess past the account-wide ceiling waits before it is checked at all. */
const OVER_CEILING_DELAY_MS = 1_000;

/**
 * How many passwords may be verified at once.
 *
 * Every attempt pays for a scrypt whether or not the account exists — the decoy hash is the
 * point — and scrypt runs on libuv's threadpool, which Node sizes at four threads. Every limit
 * above is keyed on something the caller chooses: an address it need not send, an account name
 * it can invent afresh on every request. A flood of unknown addresses therefore passes all of
 * them and leaves the threadpool as the only queue, with every other request in this process
 * waiting behind it — measured at 400 concurrent attempts, 50 KB of bodies, taking an ordinary
 * feed read from 10 ms to 1.7 s. A ceiling on how many run at once bounds that, and unlike a
 * deployment-wide rate limit it is not a lockout of its own: it clears as the hashes finish
 * rather than at the end of a fixed window.
 */
const MAX_CONCURRENT_VERIFICATIONS = 8;
let verifying = 0;

function tooMany(results: RateLimitResult[]): Response | null {
  const blocked = results.filter((c) => !c.ok);
  if (blocked.length === 0) return null;
  const retryAfter = Math.max(...blocked.map((c) => c.retryAfter));
  return refuse(retryAfter);
}

function refuse(retryAfter: number): Response {
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
    // signIn deliberately applies no ceiling to what it will verify, so an account created
    // before the length limits can still get in. A bucket *name*, though, is this process's
    // memory for fifteen minutes, and nothing longer than an address can be one.
    const account = email.slice(0, MAX_EMAIL_LENGTH);

    const checks: RateLimitResult[] = [];
    let ceiling: RateLimitResult | null = null;
    if (email) {
      if (ip) checks.push(rateLimit(`login:acct-ip:${account}:${ip}`, PER_ACCOUNT_IP.limit, PER_ACCOUNT_IP.windowMs));
      ceiling = rateLimit(`login:acct:${account}`, PER_ACCOUNT.limit, PER_ACCOUNT.windowMs);
    }
    const byAccount = tooMany(checks);
    if (byAccount) return byAccount;

    const overCeiling = ceiling !== null && !ceiling.ok;
    // Slow rather than refuse: this is the account someone else can name, so the wait is the
    // only part of the ceiling the owner can be made to pay.
    if (overCeiling) await new Promise((resolve) => setTimeout(resolve, OVER_CEILING_DELAY_MS));

    if (verifying >= MAX_CONCURRENT_VERIFICATIONS) {
      return json(
        { error: "Too many sign-in attempts. Try again shortly." },
        { status: 503, headers: { "Retry-After": "2" } },
      );
    }

    let user;
    verifying++;
    try {
      user = await signIn(email, body.password ?? "");
    } catch (err) {
      // Past the ceiling a wrong guess is refused as well as rejected, so the ceiling still
      // bites on the traffic it is for; a correct password reaches the line below instead.
      if (overCeiling && err instanceof UserFacingError) return refuse(ceiling?.retryAfter ?? 0);
      throw err;
    } finally {
      verifying--;
    }

    // A correct password clears this account's buckets, so a burst of typos doesn't linger and
    // wrong guesses by someone else cannot accumulate into a lockout. Only the account's own
    // password clears them. The shared per-address bucket is deliberately left alone: clearing
    // it would let anyone with an account of their own reset it between guesses at someone
    // else's.
    if (ip) clearRateLimit(`login:acct-ip:${account}:${ip}`);
    clearRateLimit(`login:acct:${account}`);
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    return errorResponse(err, 401);
  }
}
