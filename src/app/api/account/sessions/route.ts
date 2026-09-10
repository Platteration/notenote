/**
 * GET    /api/account/sessions — how many devices are signed in.
 * DELETE /api/account/sessions — sign out everywhere except here.
 */
import { revokeOtherSessions } from "@/lib/auth";
import { json, withUser } from "@/lib/api";
import { currentSessionKey, sessionCountFor } from "@/lib/session";

export const GET = withUser(async (_req, user) => json({ sessions: sessionCountFor(user.id) }));

export const DELETE = withUser(async (_req, user) => {
  const keep = await currentSessionKey();
  return json({ revoked: revokeOtherSessions(user.id, keep), sessions: sessionCountFor(user.id) });
});
