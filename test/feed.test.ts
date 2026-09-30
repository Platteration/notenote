import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-feed-lifecycle-secret";
const { getDb } = await import("@/lib/db");
const { signUp } = await import("@/lib/auth");
const { getFeed, purgeExpired } = await import("@/lib/feed");
const { saveSettings } = await import("@/lib/settings");
const { connectDemo, collectItems, saveConnection } = await import("@/lib/connections");
const { streakFor } = await import("@/lib/library");
const { demoItems } = await import("@/lib/providers/demo");
const { PROVIDERS } = await import("@/lib/providers");
const at = Date.UTC(2026, 8, 14, 12, 30);
let userId: string;

beforeEach(async () => {
  userId = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Test", password: "password123" })).id;
  saveSettings(userId, { timezone: "UTC", windowStart: "12:00" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("daily feed lifecycle", () => {
  it("recovers after opening an empty feed and then connecting", async () => {
    expect((await getFeed(userId, at)).status).toBe("open");
    connectDemo(userId, "youtube");
    const feed = await getFeed(userId, at);
    expect(feed.status).toBe("open");
    if (feed.status === "open") expect(feed.items.length).toBeGreaterThan(0);
  });

  it("repairs empty feeds frozen by previous versions", async () => {
    getDb().prepare("INSERT INTO daily_feeds VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, "2026-09-14", JSON.stringify({ items: [], sources: [] }), at, at, at + 1000);
    connectDemo(userId, "reddit");
    const feed = await getFeed(userId, at);
    if (feed.status !== "open") throw new Error("Expected open");
    expect(feed.items.length).toBeGreaterThan(0);
    expect((JSON.parse(String(getDb().prepare("SELECT items_json FROM daily_feeds WHERE user_id = ?").get(userId)?.items_json))).items).toEqual(feed.items);
  });

  it("returns the persisted winner to concurrent first requests", async () => {
    saveConnection(userId, "youtube", { accessToken: "test", refreshToken: null, expiresAt: null, scope: null, providerUserId: "me", displayName: "Test" }, false);
    const first = demoItems("youtube", "first", at);
    const second = demoItems("youtube", "second", at);
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const [a, b] = await Promise.all([getFeed(userId, at), getFeed(userId, at)]);
    if (a.status !== "open" || b.status !== "open") throw new Error("Expected open");
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.items).toEqual(b.items);
    expect(a.reasons).toEqual(b.reasons);
  });

  it("does not serve clips when provider I/O crosses the closing time", async () => {
    saveConnection(userId, "youtube", { accessToken: "test", refreshToken: null, expiresAt: null, scope: null, providerUserId: "me", displayName: "Test" }, false);
    let clock = at;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockImplementation(async () => {
      clock += 2000;
      return demoItems("youtube", userId, at);
    });
    expect((await getFeed(userId, Date.UTC(2026, 8, 14, 12, 59, 59))).status).toBe("locked");
  });

  it("retains streaks after feed cleanup and cascades history on account deletion", async () => {
    connectDemo(userId, "youtube");
    for (let day = 11; day <= 14; day++) await getFeed(userId, Date.UTC(2026, 8, day, 12, 30));
    purgeExpired(Date.UTC(2026, 8, 15, 15));
    expect(getDb().prepare("SELECT * FROM daily_feeds WHERE user_id = ?").all(userId)).toHaveLength(0);
    expect(streakFor(userId, "2026-09-15")).toEqual({ current: 4, longest: 4, total: 4 });
    getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
    expect(getDb().prepare("SELECT * FROM scroll_visits WHERE user_id = ?").all(userId)).toHaveLength(0);
  });

  it("does not fetch or count disabled providers", async () => {
    connectDemo(userId, "youtube");
    connectDemo(userId, "reddit");
    vi.stubEnv("ENABLED_PROVIDERS", "reddit");
    expect((await collectItems(userId, at)).map((r) => r.provider)).toEqual(["reddit"]);
    const locked = await getFeed(userId, at + 3_600_000);
    if (locked.status !== "locked") throw new Error("Expected locked");
    expect(locked.connectedCount).toBe(1);
  });
});
