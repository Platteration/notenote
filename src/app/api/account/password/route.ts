/**
 * POST /api/account/password — change the password, proving ownership with the current one.
 */
import { changePassword } from "@/lib/auth";
import { json, readJson, withUser } from "@/lib/api";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { currentSessionToken } from "@/lib/session";

/** Guessing the current password here is the same attack as guessing it at sign-in. */
const LIMIT = { limit: 8, windowMs: 15 * 60_000 };

export const POST = withUser(async (req, user) => {
  const limited = rateLimit(`password:${user.id}:${clientKey(req)}`, LIMIT.limit, LIMIT.windowMs);
  if (!limited.ok) {
    return json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(req);
  try {
    const keep = await currentSessionToken();
    const result = await changePassword(user.id, body.currentPassword ?? "", body.newPassword ?? "", keep);
    return json({ changed: true, ...result });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not change the password" }, { status: 400 });
  }
});
