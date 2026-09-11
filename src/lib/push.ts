/**
 * Web Push: one notification a day, when the hour opens.
 *
 * This is the only message the app ever sends. There is no re-engagement nudge, no "you
 * missed it", no streak-in-danger warning — an app about ending should not spend its
 * notification budget dragging people back.
 */
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { getDb, now } from "./db";
import { assertPublicHost } from "./net-guard";

export interface StoredSubscription {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: number;
  last_open_day: string | null;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/** Configure web-push, or return false when the deployment has no VAPID keys. */
export function pushConfigured(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@example.com", publicKey, privateKey);
  return true;
}

export function isValidSubscription(sub: unknown): sub is BrowserSubscription {
  if (!sub || typeof sub !== "object") return false;
  const s = sub as BrowserSubscription;
  return (
    typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length <= 2000 &&
    typeof s.keys?.p256dh === "string" &&
    typeof s.keys?.auth === "string"
  );
}

/**
 * A push endpoint is a URL the client chooses and the server POSTs to every day, which makes
 * it the second destination in the app a user picks — the Bluesky PDS being the first. Without
 * this an account holder can register `https://10.0.0.5:8443/admin`, have the server knock on
 * it once a day, and read the outcome back from the subscription list.
 */
export async function isReachableEndpoint(endpoint: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  try {
    await assertPublicHost(host);
    return true;
  } catch {
    return false;
  }
}

/** Devices one account may register. Beyond this the oldest is dropped to make room. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

/**
 * Store a device's subscription, or report that it belongs to someone else.
 *
 * The endpoint is the primary key across all users, and this upsert used to reassign
 * `user_id`, so an account that learned another user's endpoint — a shared browser profile, a
 * copied service-worker registration, a support log — could take the row over: the victim
 * silently stopped receiving their own notification and could no longer even delete it, while
 * the attacker's "your hour is open" arrived on their device. A genuine re-registration always
 * carries the same user, so refusing the cross-user case breaks nothing legitimate.
 */
export function saveSubscription(userId: string, sub: BrowserSubscription, at: number = now()): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
       WHERE push_subscriptions.user_id = excluded.user_id`,
    )
    .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, at);
  if (Number(result.changes) === 0) return false;

  // Browsers hand out a fresh endpoint fairly readily, so evict rather than refuse.
  getDb()
    .prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
         SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
  return true;
}

export function removeSubscription(endpoint: string): void {
  getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function subscriptionsFor(userId: string): StoredSubscription[] {
  return getDb().prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId) as unknown as StoredSubscription[];
}

export function subscribedUserIds(): string[] {
  return (getDb().prepare("SELECT DISTINCT user_id FROM push_subscriptions").all() as Array<{ user_id: string }>).map(
    (r) => r.user_id,
  );
}

function toWebPush(row: StoredSubscription): WebPushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

export interface DeliveryResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Send the "your hour is open" notification once per local day per device.
 * A subscription the push service rejects as gone (404/410) is deleted.
 */
export async function notifyHourOpen(userId: string, dayKey: string, minutes: number): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, removed: 0, failed: 0 };
  if (!pushConfigured()) return result;
  const db = getDb();
  const due = subscriptionsFor(userId).filter((s) => s.last_open_day !== dayKey);
  const payload = JSON.stringify({
    title: "Your hour is open",
    body: `The Daily Scroll is live for the next ${minutes} minutes.`,
    tag: `daily-scroll-${dayKey}`,
    url: "/feed",
  });

  await Promise.all(
    due.map(async (row) => {
      // Checked again here, not only when it was registered: a name that resolved publicly at
      // registration can point at 127.0.0.1 or 169.254.169.254 by the time this job runs, and
      // this job runs every minute. The Bluesky service host is re-checked before every request
      // for exactly this reason (lib/providers/bluesky.ts); a push endpoint is the same kind of
      // destination. The row is left in place rather than deleted, because a name that fails to
      // resolve for a minute is a DNS hiccup, not consent to forget someone's device.
      if (!(await isReachableEndpoint(row.endpoint))) {
        result.failed++;
        return;
      }
      try {
        await webpush.sendNotification(toWebPush(row), payload, { TTL: 60 * 50 });
        db.prepare("UPDATE push_subscriptions SET last_open_day = ? WHERE endpoint = ?").run(dayKey, row.endpoint);
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removeSubscription(row.endpoint);
          result.removed++;
        } else {
          result.failed++;
        }
      }
    }),
  );
  return result;
}
