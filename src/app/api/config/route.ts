/**
 * GET /api/config — which of sign in with Google and the shop this deployment has turned on, and
 * what is for sale: `{ auth: { google }, shop: { products: [{ id, name, description, mode, price? }] } }`.
 * With nothing configured it is `{ auth: { google: false }, shop: { products: [] } }`, and the
 * pages draw no Google or Buy control. No session needed: it says nothing about anyone.
 */
import { json } from "@/lib/api";
import { integrations } from "@/lib/integrations";

export async function GET() {
  return json(await integrations().publicConfig());
}
