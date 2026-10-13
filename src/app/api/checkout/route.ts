/**
 * POST /api/checkout `{ product }` — start paying for a product: `{ url }`, a Stripe Checkout
 * address for the page to go to. Signed in, same-site and JSON, like every other change. 404 for
 * a product not on sale (or while the shop is not configured), 409 once it is held, 429 past ten
 * an hour, 502 when Stripe cannot be reached. Nothing is granted here: only Stripe's signed
 * webhook does that (`/api/webhooks/stripe`).
 */
import { isRecord } from "../../../../server/kit/http.js";
import { json, readJson, withUser } from "@/lib/api";
import { integrations } from "@/lib/integrations";

export const POST = withUser(async (req, user) => {
  const { shop } = integrations();
  if (!shop) return json({ error: "Nothing is for sale here" }, { status: 404 });
  const body = await readJson<unknown>(req);
  const answer = await shop.checkout(user.id, isRecord(body) ? body.product : undefined);
  return json(answer.body, { status: answer.status, headers: answer.headers });
});
