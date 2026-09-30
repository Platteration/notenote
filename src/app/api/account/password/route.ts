/**
 * POST /api/account/password — change the password, proving ownership with the current one.
 */
import { changePassword } from "@/lib/auth";
import { errorResponse, json, readJson, withUser } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { currentSessionKey } from "@/lib/session";

/**
 * Guessing the current password here is the same attack as guessing it at sign-in.
 *
 * Keyed on the account alone, not the account and the address: only the account holder can
 * reach this at all, so there is no lockout to hand anyone, and a per-address key would have
 * been unlimited for a stolen session in a deployment with no trusted proxy.
 */
const LIMIT = { limit: 8, windowMs: 15 * 60_000 };

export const POST = withUser(async (req, user) => {
  const limited = rateLimit(`password:${user.id}`, LIMIT.limit, LIMIT.windowMs);
  if (!limited.ok) {
    return json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(req);
  try {
    const keep = await currentSessionKey();
    const result = await changePassword(user.id, body.currentPassword ?? "", body.newPassword ?? "", keep);
    return json({ changed: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
});
