/**
 * POST /api/webhooks/stripe — Stripe's webhook, and the only thing that grants or takes back a
 * purchase (`src/lib/integrations/shop.ts`). Register `APP_BASE_URL` + `/api/webhooks/stripe`
 * with the events the README lists. No session and no same-site check: Stripe is another site,
 * and what authenticates the request is its `Stripe-Signature` over the raw body. 404 while the
 * shop is not configured.
 */
import { errorResponse, json } from "@/lib/api";
import { integrations } from "@/lib/integrations";

export async function POST(req: Request) {
  try {
    const { shop } = integrations();
    if (!shop) return json({ error: "Not found" }, { status: 404 });
    const answer = await shop.webhook(req);
    return json(answer.body, { status: answer.status });
  } catch (err) {
    return errorResponse(err);
  }
}
