/**
 * GET /api/auth/me — the signed-in account, and what it holds: `entitlements` lists what its
 * purchases grant (`supporter`), read from what Stripe's webhook recorded. The page asks again
 * after a checkout until the webhook has arrived.
 */
import { json } from "@/lib/api";
import { integrations } from "@/lib/integrations";
import { entitlementsOf } from "@/lib/integrations/shop";
import { currentUser } from "@/lib/session";

export async function GET() {
  const user = await currentUser();
  if (!user) return json({ user: null, entitlements: [] });
  return json({
    user: { id: user.id, email: user.email, displayName: user.display_name },
    entitlements: entitlementsOf(user.id, integrations().config.records),
  });
}
