import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-push-tests";
process.env.VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

// The push service is never reachable from a test run, so stand in for it.
const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...args) },
}));

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const push = await import("@/lib/push");
const { MAX_SUBSCRIPTIONS_PER_USER } = push;

let userId: string;
const sub = (n: number) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

beforeAll(async () => {
  userId = (await signUp({ email: "push@example.com", displayName: "Push", password: "password123" })).id;
});

beforeEach(() => {
  sendNotification.mockReset();
  getDb().prepare("DELETE FROM push_subscriptions").run();
});

describe("subscription validation", () => {
  it("accepts a well-formed https subscription", () => {
    expect(push.isValidSubscription(sub(1))).toBe(true);
  });

  it("rejects malformed or insecure subscriptions", () => {
    expect(push.isValidSubscription(null)).toBe(false);
    expect(push.isValidSubscription({ endpoint: "http://push.example.com/x", keys: { p256dh: "a", auth: "b" } })).toBe(false);
    expect(push.isValidSubscription({ endpoint: "https://push.example.com/x" })).toBe(false);
    expect(push.isValidSubscription({ endpoint: `https://x.com/${"y".repeat(2100)}`, keys: { p256dh: "a", auth: "b" } })).toBe(false);
  });

  it("keeps only the most recent devices, so a browser handing out fresh endpoints cannot pile up", () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 5; i++) push.saveSubscription(userId, sub(i), 1000 + i);
    const rows = push.subscriptionsFor(userId);
    expect(rows).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
    // The oldest five were evicted, not the newest.
    expect(rows.some((r) => r.endpoint === sub(0).endpoint)).toBe(false);
    expect(rows.some((r) => r.endpoint === sub(MAX_SUBSCRIPTIONS_PER_USER + 4).endpoint)).toBe(true);
  });

  it("stores one row per endpoint and updates keys on re-subscribe", () => {
    push.saveSubscription(userId, sub(1));
    push.saveSubscription(userId, { ...sub(1), keys: { p256dh: "new", auth: "new" } });
    const rows = push.subscriptionsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe("new");
  });
});

describe("daily delivery", () => {
  it("sends once per device and not again the same day", async () => {
    push.saveSubscription(userId, sub(1));
    push.saveSubscription(userId, sub(2));
    sendNotification.mockResolvedValue({});

    const first = await push.notifyHourOpen(userId, "2026-09-06", 60);
    expect(first.sent).toBe(2);

    const second = await push.notifyHourOpen(userId, "2026-09-06", 60);
    expect(second.sent).toBe(0);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("sends again on the next day", async () => {
    push.saveSubscription(userId, sub(1));
    sendNotification.mockResolvedValue({});
    await push.notifyHourOpen(userId, "2026-09-06", 60);
    const next = await push.notifyHourOpen(userId, "2026-09-07", 60);
    expect(next.sent).toBe(1);
  });

  it("carries the hour length and a deep link in the payload", async () => {
    push.saveSubscription(userId, sub(1));
    sendNotification.mockResolvedValue({});
    await push.notifyHourOpen(userId, "2026-09-06", 60);
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(payload.body).toContain("60 minutes");
    expect(payload.url).toBe("/feed");
    expect(payload.tag).toBe("daily-scroll-2026-09-06");
  });

  it("drops a subscription the push service says is gone", async () => {
    push.saveSubscription(userId, sub(1));
    sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const result = await push.notifyHourOpen(userId, "2026-09-06", 60);
    expect(result.removed).toBe(1);
    expect(push.subscriptionsFor(userId)).toHaveLength(0);
  });

  it("keeps a subscription that failed for a transient reason", async () => {
    push.saveSubscription(userId, sub(1));
    sendNotification.mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    const result = await push.notifyHourOpen(userId, "2026-09-06", 60);
    expect(result.failed).toBe(1);
    expect(push.subscriptionsFor(userId)).toHaveLength(1);
    // Not marked as delivered, so the next run tries again.
    sendNotification.mockResolvedValue({});
    expect((await push.notifyHourOpen(userId, "2026-09-06", 60)).sent).toBe(1);
  });
});
