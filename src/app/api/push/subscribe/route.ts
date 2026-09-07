import { json, readJson, withUser } from "@/lib/api";
import { isValidSubscription, removeSubscription, saveSubscription, subscriptionsFor, vapidPublicKey } from "@/lib/push";

export const GET = withUser(async (_req, user) =>
  json({ subscriptions: subscriptionsFor(user.id).map((s) => ({ endpoint: s.endpoint, createdAt: s.created_at })) }),
);

export const POST = withUser(async (req, user) => {
  if (!vapidPublicKey()) return json({ error: "Push is not configured on this server" }, { status: 503 });
  const body = await readJson<{ subscription?: unknown }>(req);
  if (!isValidSubscription(body.subscription)) return json({ error: "Invalid push subscription" }, { status: 400 });
  saveSubscription(user.id, body.subscription);
  return json({ subscribed: true });
});

export const DELETE = withUser(async (req, user) => {
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint) return json({ error: "An endpoint is required" }, { status: 400 });
  // Only remove a subscription that belongs to the signed-in user.
  if (!subscriptionsFor(user.id).some((s) => s.endpoint === endpoint)) {
    return json({ error: "Unknown subscription" }, { status: 404 });
  }
  removeSubscription(endpoint);
  return json({ subscribed: false });
});
