/**
 * Web Push: one notification a day, when the hour opens.
 *
 * This is the only message the app ever sends. There is no re-engagement nudge, no "you
 * missed it", no streak-in-danger warning — an app about ending should not spend its
 * notification budget dragging people back.
 */
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { getDb, now } from "./db";

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

export function saveSubscription(userId: string, sub: BrowserSubscription, at: number = now()): void {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, at);
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
