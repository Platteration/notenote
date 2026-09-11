import { signUp } from "@/lib/auth";
import { assertSameSite, errorResponse, json, readJson } from "@/lib/api";
import { clientKey, peekRateLimit, rateLimit } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/** Enough for a household behind one address, low enough to stop bulk registration. */
const PER_IP = { limit: 5, windowMs: 60 * 60_000 };
/**
 * A ceiling for the whole deployment, applied whether or not the client can be identified. It
 * exists only to bound bulk registration when no trusted proxy names the client and the
 * per-address limit therefore cannot run.
 *
 * Charged for an account that was actually created, not for a request that was made. Charging
 * it on the way in made it a deployment-wide registration outage for anyone: 200 posts of `{}`
 * cost about 5 KB and six seconds, created nothing, and answered every later sign-up — from
 * anybody — with 429 for the rest of the fixed window. So it is peeked before the work and
 * charged after it, and 200 genuine registrations in an hour, the case it is for, still trips
 * it.
 */
const PER_DEPLOYMENT = { limit: 200, windowMs: 60 * 60_000 };

export async function POST(req: Request) {
  try {
    assertSameSite(req);
    const ip = clientKey(req);
    const checks = [peekRateLimit("signup:deployment", PER_DEPLOYMENT.limit)];
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
    // An account exists now, so the deployment ceiling is charged for it.
    rateLimit("signup:deployment", PER_DEPLOYMENT.limit, PER_DEPLOYMENT.windowMs);
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
