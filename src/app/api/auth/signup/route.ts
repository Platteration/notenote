import { signUp } from "@/lib/auth";
import { assertSameSite, errorResponse, json, readJson } from "@/lib/api";
import { clientKey, rateLimit, refundRateLimit } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/** Enough for a household behind one address, low enough to stop bulk registration. */
const PER_IP = { limit: 5, windowMs: 60 * 60_000 };
/**
 * A ceiling for the whole deployment, applied whether or not the client can be identified. It
 * exists only to bound bulk registration when no trusted proxy names the client and the
 * per-address limit therefore cannot run — which is the default, so for most deployments this is
 * the only limit on registration there is.
 *
 * Charged for an account that was actually created, not for a request that was made: 200 posts
 * of `{}` cost about 5 KB and six seconds, create nothing, and used to answer every later
 * sign-up — from anybody — with 429 for the rest of the fixed window.
 *
 * "Charged for the account" still means charged on the way *in*, and refunded when no account
 * came of it. Reading the bucket on the way in and charging it after `signUp` put the decision
 * and the charge on opposite sides of a scrypt, so every concurrent request read the same
 * unspent bucket: 260 concurrent sign-ups created 260 accounts against this ceiling of 200. A
 * request holds its place only while it is in flight, so a burst of junk can crowd the ceiling
 * for the milliseconds it takes to reject them, and nothing longer.
 */
const PER_DEPLOYMENT = { limit: 200, windowMs: 60 * 60_000 };
const DEPLOYMENT_KEY = "signup:deployment";

export async function POST(req: Request) {
  let reserved = false;
  let created = false;
  try {
    assertSameSite(req);
    const ip = clientKey(req);
    const checks = [rateLimit(DEPLOYMENT_KEY, PER_DEPLOYMENT.limit, PER_DEPLOYMENT.windowMs)];
    reserved = true;
    if (ip) checks.push(rateLimit(`signup:ip:${ip}`, PER_IP.limit, PER_IP.windowMs));
    const limited = checks.find((c) => !c.ok);
    if (limited) {
      return json(
        { error: "Too many accounts created from here. Try again later." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
      );
    }
    const body = await readJson<{ email?: string; displayName?: string; password?: string; timezone?: string }>(req);
    const user = await signUp({
      email: body.email ?? "",
      displayName: body.displayName ?? "",
      password: body.password ?? "",
      timezone: body.timezone,
    });
    // An account exists now, so the reservation the ceiling made is kept rather than refunded.
    created = true;
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  } finally {
    if (reserved && !created) refundRateLimit(DEPLOYMENT_KEY);
  }
}
