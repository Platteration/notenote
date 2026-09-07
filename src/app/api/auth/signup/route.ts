import { signUp } from "@/lib/auth";
import { errorResponse, json, readJson } from "@/lib/api";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { createSession } from "@/lib/session";

/** Enough for a household behind one address, low enough to stop bulk registration. */
const PER_IP = { limit: 5, windowMs: 60 * 60_000 };

export async function POST(req: Request) {
  try {
    const limited = rateLimit(`signup:ip:${clientKey(req)}`, PER_IP.limit, PER_IP.windowMs);
    if (!limited.ok) {
      return json(
        { error: "Too many accounts created from here. Try again later." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
      );
    }
    const body = await readJson<{ email?: string; displayName?: string; password?: string; timezone?: string }>(req);
    const user = signUp({
      email: body.email ?? "",
      displayName: body.displayName ?? "",
      password: body.password ?? "",
      timezone: body.timezone,
    });
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
