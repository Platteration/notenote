/**
 * GET /api/auth/google/start?return=<path>&tz=<zone> — begin signing in (or up) with Google: a
 * 302 to Google's consent page, with the flow's state in a signed ten-minute cookie
 * (`src/lib/integrations/google.ts`). A GET, because a link starts it and it changes nothing a
 * third party could use: the state check at the callback is what stops a login CSRF. 404 while
 * sign in with Google is not configured.
 */
import { json } from "@/lib/api";
import { integrations } from "@/lib/integrations";
import { returnPath, timezoneParam } from "@/lib/integrations/google";
import { redirectTo } from "@/lib/integrations/respond";

export async function GET(req: Request) {
  const { google } = integrations();
  if (!google) return json({ error: "Not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const { location, cookie } = await google.start({
    intent: "signin",
    userId: null,
    returnTo: returnPath(params.get("return")),
    timezone: timezoneParam(params.get("tz")),
  });
  return redirectTo(location, [cookie]);
}
