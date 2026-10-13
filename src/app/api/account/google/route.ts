/**
 * POST /api/account/google — begin linking a Google account to the signed-in account, from
 * Settings: `{ url }`, Google's consent page, for the page to go to, with the flow in a signed
 * ten-minute cookie naming this account. The callback links it only if the browser is still
 * signed in to the same account. A POST behind the same-site check, like every other change to
 * an account: no other site can start a link. 404 while sign in with Google is not configured.
 */
import { json, withUser } from "@/lib/api";
import { googleIdentityFor } from "@/lib/google-accounts";
import { integrations } from "@/lib/integrations";

export const POST = withUser(async (_req, user) => {
  const { google } = integrations();
  if (!google) return json({ error: "Sign in with Google is not set up here" }, { status: 404 });
  if (googleIdentityFor(user.id)) return json({ error: "A Google account is already linked to this account" }, { status: 409 });
  const { location, cookie } = await google.start({ intent: "link", userId: user.id, returnTo: null, timezone: null });
  return json({ url: location }, { headers: { "Set-Cookie": cookie } });
});
