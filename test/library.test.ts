import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-library-tests";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { listMuted, listSaved, muteCreator, mutedSet, saveItem, streakFor, unmuteCreator, unsaveItem } = await import("@/lib/library");
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

beforeAll(() => {
  userId = signUp({ email: "library@example.com", displayName: "Lib", password: "password123" }).id;
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

describe("streak", () => {
  it("counts consecutive days ending today", () => {
    for (const day of ["2026-09-04", "2026-09-05", "2026-09-06"]) seedFeed(day, []);
    const s = streakFor(userId, "2026-09-06");
    expect(s.current).toBe(3);
    expect(s.total).toBe(3);
  });

  it("still counts a run that ended yesterday, and breaks on a gap", () => {
    expect(streakFor(userId, "2026-09-07").current).toBe(3);
    expect(streakFor(userId, "2026-09-09").current).toBe(0);
  });

  it("reports the longest run across gaps", () => {
    seedFeed("2026-08-01", []);
    const s = streakFor(userId, "2026-09-06");
    expect(s.longest).toBe(3);
    expect(s.total).toBe(4);
  });

  it("is zero for a user who has never opened the scroll", () => {
    const other = signUp({ email: "fresh@example.com", displayName: "Fresh", password: "password123" }).id;
    expect(streakFor(other, "2026-09-06")).toEqual({ current: 0, longest: 0, total: 0 });
  });
});
