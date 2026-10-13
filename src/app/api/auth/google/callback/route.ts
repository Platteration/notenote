/**
 * GET /api/auth/google/callback — Google's redirect back, for a sign-in and for a link alike.
 * Register `APP_BASE_URL` + `/api/auth/google/callback` with the Google client.
 *
 * Google says who this is (`src/lib/integrations/google.ts`); what that does to the accounts here
 * is `src/lib/google-accounts.ts`: a linked Google account signs in to its account, a new one
 * makes an account, an address another account already has makes nothing, and a link is made
 * only for the account the flow was started from and is still signed in. A sign-in ends in a new
 * session (never the one the browser held), as a password sign-in does. Every answer clears the
 * flow cookie, and a failure sends the browser back with a word of the app's own
 * (`?signin=failed`, `?link=taken`, …), never anything Google said.
 */
import { json } from "@/lib/api";
import { signInWithGoogle, linkGoogle } from "@/lib/google-accounts";
import { integrations } from "@/lib/integrations";
import { redirectTo } from "@/lib/integrations/respond";
import { clientKey } from "@/lib/rate-limit";
import { createSession, currentUser, destroySession } from "@/lib/session";

export async function GET(req: Request) {
  const { google } = integrations();
  if (!google) return json({ error: "Not found" }, { status: 404 });
  const base = google.origin;
  const clear = [google.clearCookie];
  const outcome = await google.finish(req);
  if (!outcome.ok) return redirectTo(outcome.intent === "link" ? `${base}/settings?link=failed` : `${base}/?signin=failed`, clear);
  const { flow, identity } = outcome;

  if (flow.i === "link") {
    try {
      const user = await currentUser();
      if (!user || user.id !== flow.u) {
        console.warn("Linking Google failed (the browser is no longer signed in to the account that asked)");
        return redirectTo(`${base}/settings?link=failed`, clear);
      }
      const linked = linkGoogle(user.id, identity);
      const word = linked === "linked" || linked === "already-linked" ? "done" : linked === "taken" ? "taken" : "failed";
      return redirectTo(`${base}/settings?link=${word}`, clear);
    } catch (err) {
      console.error("Linking Google failed:", err);
      return redirectTo(`${base}/settings?link=failed`, clear);
    }
  }

  try {
    const result = signInWithGoogle(identity, { timezone: flow.z, ip: clientKey(req) });
    if (result.kind === "exists") return redirectTo(`${base}/?signin=exists`, clear);
    if (result.kind === "no-email") return redirectTo(`${base}/?signin=noemail`, clear);
    if (result.kind === "limited") return redirectTo(`${base}/?signin=limited`, clear);
    // A new session at every sign-in, so none can be planted beforehand, and the one the browser
    // held (perhaps another account's) ends here.
    await destroySession();
    await createSession(result.userId);
    return redirectTo(`${base}${flow.r ?? (result.created ? "/connect" : "/feed")}`, clear);
  } catch (err) {
    console.error("Sign in with Google failed:", err);
    return redirectTo(`${base}/?signin=failed`, clear);
  }
}
