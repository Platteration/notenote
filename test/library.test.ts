import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-library-tests";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { MAX_MUTED_CREATORS, listMuted, listSaved, muteCreator, mutedSet, recordHourOpen, saveItem, streakFor, unmuteCreator, unsaveItem } =
  await import("@/lib/library");
const { getFeed, markSeen, purgeExpired } = await import("@/lib/feed");
const { curate } = await import("@/lib/curation");
const { demoItems } = await import("@/lib/providers/demo");

let userId: string;
const NOW = Date.UTC(2026, 8, 6, 12, 0);

function seedFeed(dayKey: string, items: unknown[]) {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, dayKey, JSON.stringify({ items, sources: [] }), NOW, NOW, NOW + 3_600_000);
}

beforeAll(async () => {
  userId = (await signUp({ email: "library@example.com", displayName: "Lib", password: "password123" })).id;
});

describe("saved shelf", () => {
  it("saves a clip from one of the user's own feeds and keeps its content", () => {
    const items = demoItems("youtube", userId, NOW, 3);
    seedFeed("2026-09-06", items);
    const saved = saveItem(userId, items[0].key, NOW);
    expect(saved.item.title).toBe(items[0].title);
    const list = listSaved(userId);
    expect(list).toHaveLength(1);
    expect(list[0].item.permalink).toBe(items[0].permalink);
  });

  it("refuses a key that isn't in any of the user's feeds", () => {
    expect(() => saveItem(userId, "youtube:not-mine", NOW)).toThrow(/recent feeds/);
  });

  it("removes a saved clip", () => {
    const items = demoItems("youtube", userId, NOW, 3);
    unsaveItem(userId, items[0].key);
    expect(listSaved(userId)).toHaveLength(0);
  });
});

describe("muted creators", () => {
  it("records and lifts a mute, case-insensitively", () => {
    muteCreator(userId, "youtube", "AdaLoops", NOW);
    expect(listMuted(userId)).toEqual([{ provider: "youtube", creatorHandle: "adaloops", mutedAt: NOW }]);
    expect(mutedSet(userId).has("youtube:adaloops")).toBe(true);
    unmuteCreator(userId, "youtube", "adaloops");
    expect(listMuted(userId)).toHaveLength(0);
  });

  it("caps how many creators one account can mute", () => {
    const fresh = getDb();
    fresh.prepare("DELETE FROM muted_creators WHERE user_id = ?").run(userId);
    for (let i = 0; i < MAX_MUTED_CREATORS; i++) muteCreator(userId, "youtube", `creator-${i}`, NOW);
    expect(listMuted(userId)).toHaveLength(MAX_MUTED_CREATORS);
    expect(() => muteCreator(userId, "youtube", "one-too-many", NOW)).toThrow(/up to 500/);
    fresh.prepare("DELETE FROM muted_creators WHERE user_id = ?").run(userId);
  });

  it("keeps muted creators out of the curated feed", () => {
    const items = demoItems("youtube", userId, NOW, 30);
    const target = items[0].creatorHandle;
    const base = { size: 20, seed: "s", now: NOW, seenKeys: new Set<string>() };
    const before = curate(items, base).items.filter((i) => i.creatorHandle === target).length;
    const after = curate(items, { ...base, mutedCreators: new Set([`youtube:${target.toLowerCase()}`]) }).items;
    expect(before).toBeGreaterThan(0);
    expect(after.filter((i) => i.creatorHandle === target)).toHaveLength(0);
  });
});

describe("recording what was watched", () => {
  it("accepts keys from the user's own feed", () => {
    const items = demoItems("youtube", userId, NOW, 4);
    seedFeed("2026-09-10", items);
    expect(markSeen(userId, items.slice(0, 2).map((i) => i.key), NOW)).toBe(2);
  });

  it("ignores keys that are not in any of the user's feeds", () => {
    // Taking arbitrary strings would let a caller grow this table without limit, and every
    // key is loaded into memory when a feed is built.
    expect(markSeen(userId, ["youtube:invented", "x".repeat(500), "reddit:also-invented"], NOW)).toBe(0);
  });

  it("keeps the real keys and drops the invented ones in the same call", () => {
    const items = demoItems("tiktok", userId, NOW, 3);
    seedFeed("2026-09-11", items);
    expect(markSeen(userId, [items[0].key, "tiktok:not-real"], NOW)).toBe(1);
  });
});

describe("streak", () => {
  // Showing up is recorded in its own ledger, so start from a known set rather than
  // depending on whatever earlier tests happened to seed.
  beforeAll(() => {
    getDb().prepare("DELETE FROM daily_feeds WHERE user_id = ?").run(userId);
    getDb().prepare("DELETE FROM hour_opens WHERE user_id = ?").run(userId);
  });

  it("counts consecutive days ending today", () => {
    for (const day of ["2026-09-04", "2026-09-05", "2026-09-06"]) recordHourOpen(userId, day, NOW);
    const s = streakFor(userId, "2026-09-06");
    expect(s.current).toBe(3);
    expect(s.total).toBe(3);
  });

  it("still counts a run that ended yesterday, and breaks on a gap", () => {
    expect(streakFor(userId, "2026-09-07").current).toBe(3);
    expect(streakFor(userId, "2026-09-09").current).toBe(0);
  });

  it("reports the longest run across gaps", () => {
    recordHourOpen(userId, "2026-08-01", NOW);
    const s = streakFor(userId, "2026-09-06");
    expect(s.longest).toBe(3);
    expect(s.total).toBe(4);
  });

  it("survives the sweep that removes the feeds those days produced", () => {
    // The regression: streaks used to be read from daily_feeds, which purgeExpired empties a
    // day after each hour closes, so no ordinary user could ever show more than two days.
    // The bound comes from the sweep's own threshold rather than from the streak code.
    const db = getDb();
    db.prepare("DELETE FROM daily_feeds WHERE user_id = ?").run(userId);
    const dayMs = 86_400_000;
    for (let back = 0; back < 4; back++) {
      const closes = NOW - back * dayMs;
      seedFeed(new Date(closes).toISOString().slice(0, 10), []);
      recordHourOpen(userId, new Date(closes).toISOString().slice(0, 10), closes);
    }
    const swept = purgeExpired(NOW + 2 * dayMs);
    expect(swept.feeds).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM daily_feeds WHERE user_id = ?").get(userId)).toEqual({ c: 0 });

    const todayKey = new Date(NOW).toISOString().slice(0, 10);
    const s = streakFor(userId, todayKey);
    expect(s.current).toBe(4);
    expect(s.longest).toBeGreaterThanOrEqual(4);
  });

  it("records the open on every request inside the hour, not only the one that builds the feed", async () => {
    // The ledger has to be written where the user turns up. The feed row is created once a
    // day, and the prewarm cron builds items without creating one at all, so hanging the
    // streak off that row is what made it wrong in the first place.
    const db = getDb();
    db.prepare("DELETE FROM daily_feeds WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM hour_opens WHERE user_id = ?").run(userId);
    const inTheHour = Date.UTC(2026, 8, 6, 20, 30); // default window opens at 20:00 UTC

    expect((await getFeed(userId, inTheHour)).status).toBe("open");
    expect(db.prepare("SELECT day_key FROM hour_opens WHERE user_id = ?").all(userId)).toEqual([{ day_key: "2026-09-06" }]);

    // Second visit of the same hour: the feed row already exists, so nothing is inserted there.
    db.prepare("DELETE FROM hour_opens WHERE user_id = ?").run(userId);
    expect((await getFeed(userId, inTheHour + 60_000)).status).toBe("open");
    expect(db.prepare("SELECT day_key FROM hour_opens WHERE user_id = ?").all(userId)).toEqual([{ day_key: "2026-09-06" }]);

    db.prepare("DELETE FROM daily_feeds WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM hour_opens WHERE user_id = ?").run(userId);
  });

  it("is zero for a user who has never opened the scroll", async () => {
    const other = (await signUp({ email: "fresh@example.com", displayName: "Fresh", password: "password123" })).id;
    expect(streakFor(other, "2026-09-06")).toEqual({ current: 0, longest: 0, total: 0 });
  });
});
