import { json, readJson, withUser } from "@/lib/api";
import {
  isReachableEndpoint,
  isValidSubscription,
  removeSubscription,
  saveSubscription,
  subscriptionsFor,
  vapidPublicKey,
} from "@/lib/push";

export const GET = withUser(async (_req, user) =>
  json({ subscriptions: subscriptionsFor(user.id).map((s) => ({ endpoint: s.endpoint, createdAt: s.created_at })) }),
);

export const POST = withUser(async (req, user) => {
  if (!vapidPublicKey()) return json({ error: "Push is not configured on this server" }, { status: 503 });
  const body = await readJson<{ subscription?: unknown }>(req);
  if (!isValidSubscription(body.subscription)) return json({ error: "Invalid push subscription" }, { status: 400 });
  // The server will POST to this URL on a schedule, so it goes through the network guard.
  if (!(await isReachableEndpoint(body.subscription.endpoint))) {
    return json({ error: "That push endpoint is not one this server will send to" }, { status: 400 });
  }
  if (!saveSubscription(user.id, body.subscription)) {
    return json({ error: "That endpoint is already registered to another account" }, { status: 409 });
  }
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
