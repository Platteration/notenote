import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-archive-tests";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { listSaved, readSaved, saveItem, unsaveItem } = await import("@/lib/library");
const archive = await import("@/lib/archive");
const limits = await import("@/lib/archive-limits");
const { getFeed } = await import("@/lib/feed");
const { saveSettings } = await import("@/lib/settings");
const { connectDemo } = await import("@/lib/connections");
const { demoItems } = await import("@/lib/providers/demo");
import type { MediaItem } from "@/lib/providers/types";

const NOW = Date.UTC(2026, 8, 20, 12, 0);
let userId: string;

beforeEach(async () => {
  userId = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Archivist", password: "password123" })).id;
});

function clip(overrides: Partial<MediaItem> & { externalId: string }): MediaItem {
  return {
    key: `youtube:${overrides.externalId}`,
    provider: "youtube",
    title: `Clip ${overrides.externalId}`,
    creator: "Creator",
    creatorHandle: "creator",
    permalink: "https://www.youtube.com/shorts/x",
    thumbnailUrl: null,
    videoUrl: null,
    durationSeconds: 30,
    publishedAt: NOW - 3_600_000,
    metrics: { views: 10 },
    ...overrides,
  };
}

/** Put clips in one of the user's feeds and save them, the only way a clip reaches the archive. */
function seedAndSave(userOf: string, items: MediaItem[]) {
  getDb()
    .prepare("INSERT OR REPLACE INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userOf, "2026-09-20", JSON.stringify({ items, sources: [] }), NOW, NOW, NOW + 3_600_000);
  for (const it of items) saveItem(userOf, it.key, NOW);
}

describe("notes", () => {
  it("starts empty, can be set and cleared, and shows on the shelf", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    expect(readSaved(userId, "youtube:a")).toMatchObject({ note: "", collections: [] });
    expect(archive.setNote(userId, "youtube:a", "watch with Sam").note).toBe("watch with Sam");
    expect(listSaved(userId)[0]!.note).toBe("watch with Sam");
    expect(archive.setNote(userId, "youtube:a", "").note).toBe("");
  });

  it("takes exactly the maximum length and not a character more", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    expect(archive.setNote(userId, "youtube:a", "x".repeat(limits.MAX_NOTE_LENGTH)).note).toHaveLength(limits.MAX_NOTE_LENGTH);
    expect(() => archive.setNote(userId, "youtube:a", "x".repeat(limits.MAX_NOTE_LENGTH + 1))).toThrow(String(limits.MAX_NOTE_LENGTH));
  });

  it("only annotates the user's own saved clips", async () => {
    const other = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Other", password: "password123" })).id;
    seedAndSave(other, [clip({ externalId: "theirs" })]);
    expect(() => archive.setNote(userId, "youtube:theirs", "mine now")).toThrow(/archive/);
    expect(readSaved(other, "youtube:theirs")!.note).toBe("");
  });

  it("survives saving the same clip again, and starts over after it is removed", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    archive.setNote(userId, "youtube:a", "keep this");
    saveItem(userId, "youtube:a", NOW + 1000);
    expect(readSaved(userId, "youtube:a")!.note).toBe("keep this");
    unsaveItem(userId, "youtube:a", { confirmed: true });
    saveItem(userId, "youtube:a", NOW + 2000);
    expect(readSaved(userId, "youtube:a")!.note).toBe("");
  });
});

describe("removing a clip", () => {
  it("removes a plain clip without asking", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    unsaveItem(userId, "youtube:a");
    expect(readSaved(userId, "youtube:a")).toBeNull();
  });

  it("refuses to drop a clip with a note until the removal is confirmed", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    archive.setNote(userId, "youtube:a", "my thoughts");
    expect(() => unsaveItem(userId, "youtube:a")).toThrow(/Confirm/);
    expect(readSaved(userId, "youtube:a")!.note).toBe("my thoughts");
    unsaveItem(userId, "youtube:a", { confirmed: true });
    expect(readSaved(userId, "youtube:a")).toBeNull();
  });

  it("treats a place in a collection the same way, and takes the membership with the clip", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    const c = archive.createCollection(userId, "Cooking");
    archive.addToCollection(userId, c.id, "youtube:a");
    expect(() => unsaveItem(userId, "youtube:a")).toThrow(/Confirm/);
    unsaveItem(userId, "youtube:a", { confirmed: true });
    expect(getDb().prepare("SELECT * FROM collection_items WHERE user_id = ?").all(userId)).toHaveLength(0);
    expect(archive.getCollection(userId, c.id)!.count).toBe(0);
  });
});

describe("collections", () => {
  it("are created trimmed and empty, and need a name", () => {
    expect(archive.createCollection(userId, "  Cooking  ")).toMatchObject({ name: "Cooking", count: 0 });
    expect(() => archive.createCollection(userId, "   ")).toThrow(/name/);
    expect(() => archive.createCollection(userId, 42)).toThrow(/name/);
    expect(() => archive.createCollection(userId, "x".repeat(limits.MAX_COLLECTION_NAME + 1))).toThrow(String(limits.MAX_COLLECTION_NAME));
    expect(archive.createCollection(userId, "y".repeat(limits.MAX_COLLECTION_NAME)).name).toHaveLength(limits.MAX_COLLECTION_NAME);
  });

  it("have names unique per person whatever the case, and another person may reuse one", async () => {
    archive.createCollection(userId, "Cooking");
    expect(() => archive.createCollection(userId, "cooking")).toThrow(/already/);
    const other = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Other", password: "password123" })).id;
    expect(archive.createCollection(other, "Cooking").name).toBe("Cooking");
  });

  it("stop at the maximum count", () => {
    for (let i = 0; i < limits.MAX_COLLECTIONS; i++) archive.createCollection(userId, `c${i}`);
    expect(() => archive.createCollection(userId, "one more")).toThrow(String(limits.MAX_COLLECTIONS));
  });

  it("can be renamed, but not onto another's name", () => {
    const a = archive.createCollection(userId, "Cooking");
    archive.createCollection(userId, "Travel");
    expect(archive.renameCollection(userId, a.id, "Dinner ideas").name).toBe("Dinner ideas");
    expect(() => archive.renameCollection(userId, a.id, "travel")).toThrow(/already/);
  });

  it("are deleted without touching the clips or their notes", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    archive.setNote(userId, "youtube:a", "still here");
    const c = archive.createCollection(userId, "Cooking");
    archive.addToCollection(userId, c.id, "youtube:a");
    expect(archive.deleteCollection(userId, c.id)).toBe(true);
    expect(archive.deleteCollection(userId, c.id)).toBe(false);
    expect(readSaved(userId, "youtube:a")).toMatchObject({ note: "still here", collections: [] });
  });

  it("belong to one person only", async () => {
    const other = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Other", password: "password123" })).id;
    const theirs = archive.createCollection(other, "Theirs");
    expect(() => archive.renameCollection(userId, theirs.id, "Mine")).toThrow(/No such collection/);
    expect(archive.deleteCollection(userId, theirs.id)).toBe(false);
    expect(archive.getCollection(other, theirs.id)).not.toBeNull();
  });
});

describe("filing clips", () => {
  it("files a saved clip once, however often it is asked, and takes it out again", () => {
    seedAndSave(userId, [clip({ externalId: "a" })]);
    const c = archive.createCollection(userId, "Cooking");
    expect(archive.addToCollection(userId, c.id, "youtube:a").collections).toEqual([c.id]);
    archive.addToCollection(userId, c.id, "youtube:a");
    expect(archive.getCollection(userId, c.id)!.count).toBe(1);
    expect(archive.removeFromCollection(userId, c.id, "youtube:a").collections).toEqual([]);
  });

  it("refuses a clip the user never saved, including someone else's", async () => {
    const c = archive.createCollection(userId, "Cooking");
    expect(() => archive.addToCollection(userId, c.id, "youtube:never")).toThrow(/archive/);
    const other = (await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Other", password: "password123" })).id;
    seedAndSave(other, [clip({ externalId: "theirs" })]);
    expect(() => archive.addToCollection(userId, c.id, "youtube:theirs")).toThrow(/archive/);
  });
});

describe("the archive's size", () => {
  it("holds up to the maximum and refuses the next new clip, but still refreshes one it holds", () => {
    const db = getDb();
    const insert = db.prepare("INSERT INTO saved_items (user_id, item_key, item_json, saved_at) VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < limits.MAX_SAVED_ITEMS - 1; i++) insert.run(userId, `filler:${i}`, "{}", 0);
    db.exec("COMMIT");
    seedAndSave(userId, [clip({ externalId: "last" })]); // the 5000th
    expect(() => saveItem(userId, "youtube:last", NOW)).not.toThrow();
    getDb()
      .prepare("INSERT OR REPLACE INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, "2026-09-21", JSON.stringify({ items: [clip({ externalId: "over" })], sources: [] }), NOW + 1, NOW, NOW + 3_600_000);
    expect(() => saveItem(userId, "youtube:over", NOW)).toThrow(String(limits.MAX_SAVED_ITEMS));
  });
});

describe("search", () => {
  beforeEach(() => {
    seedAndSave(userId, [
      clip({ externalId: "a", title: "Knife skills in five minutes", creator: "Chef Ada", creatorHandle: "chefada" }),
      clip({ externalId: "b", title: "100% whole wheat loaf", creator: "Baker", creatorHandle: "a_b_bakes" }),
      clip({ externalId: "c", provider: "reddit", key: "reddit:c", title: "Street food tour", creator: "Wanderer", creatorHandle: "wander" }),
    ]);
  });
  const keys = (q: Parameters<typeof archive.searchSaved>[1]) => archive.searchSaved(userId, q).map((s) => s.item.key).sort();

  it("matches title, creator, handle, note and collection name, ignoring ASCII case", () => {
    expect(keys({ q: "KNIFE" })).toEqual(["youtube:a"]);
    expect(keys({ q: "chef ada" })).toEqual(["youtube:a"]);
    expect(keys({ q: "wander" })).toEqual(["reddit:c"]);
    archive.setNote(userId, "youtube:b", "Try with rye flour");
    expect(keys({ q: "rye" })).toEqual(["youtube:b"]);
    const c = archive.createCollection(userId, "Weekend baking");
    archive.addToCollection(userId, c.id, "youtube:b");
    expect(keys({ q: "weekend" })).toEqual(["youtube:b"]);
  });

  it("folds case for ASCII letters only, as SQLite's LIKE does", () => {
    seedAndSave(userId, [clip({ externalId: "e", title: "Élan in the kitchen" })]);
    expect(keys({ q: "Élan" })).toEqual(["youtube:e"]);
    expect(keys({ q: "élan" })).toEqual([]);
  });

  it("treats % and _ as the characters they are", () => {
    expect(keys({ q: "100%" })).toEqual(["youtube:b"]);
    expect(keys({ q: "a_b" })).toEqual(["youtube:b"]);
    expect(keys({ q: "%" })).toEqual(["youtube:b"]);
  });

  it("never matches inside the stored copy as a whole", () => {
    // Demo posters are SVG data URIs; matching the raw JSON would find "svg" in every one.
    seedAndSave(userId, demoItems("youtube", "archive", NOW).slice(0, 3));
    expect(keys({ q: "svg" })).toEqual([]);
  });

  it("narrows to a platform, a collection, or both", () => {
    expect(keys({ provider: "reddit" })).toEqual(["reddit:c"]);
    const c = archive.createCollection(userId, "Food");
    archive.addToCollection(userId, c.id, "youtube:a");
    archive.addToCollection(userId, c.id, "reddit:c");
    expect(keys({ collectionId: c.id })).toEqual(["reddit:c", "youtube:a"]);
    expect(keys({ collectionId: c.id, provider: "youtube" })).toEqual(["youtube:a"]);
    expect(keys({ collectionId: c.id, q: "street" })).toEqual(["reddit:c"]);
  });

  it("skips a clip whose stored copy is unreadable instead of failing, whatever the filter", () => {
    getDb().prepare("INSERT INTO saved_items (user_id, item_key, item_json, saved_at) VALUES (?, ?, ?, ?)").run(userId, "youtube:bad", "not json", NOW);
    expect(listSaved(userId).map((s) => s.item.key)).not.toContain("youtube:bad");
    expect(keys({ q: "knife" })).toEqual(["youtube:a"]);
    expect(keys({ provider: "youtube" })).toEqual(["youtube:a", "youtube:b"]);
    const c = archive.createCollection(userId, "All");
    archive.addToCollection(userId, c.id, "youtube:a");
    expect(keys({ collectionId: c.id })).toEqual(["youtube:a"]);
  });

  it("refuses an overlong search, an unknown platform and a collection that is not theirs", () => {
    expect(() => archive.searchSaved(userId, { q: "x".repeat(limits.MAX_SEARCH_QUERY + 1) })).toThrow(String(limits.MAX_SEARCH_QUERY));
    expect(() => archive.searchSaved(userId, { provider: "myspace" })).toThrow(/platform/);
    expect(() => archive.searchSaved(userId, { provider: "constructor" })).toThrow(/platform/);
    expect(() => archive.searchSaved(userId, { collectionId: "nope" })).toThrow(/No such collection/);
  });

  it("returns at most the search limit, newest first", () => {
    const insert = getDb().prepare("INSERT INTO saved_items (user_id, item_key, item_json, saved_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < limits.ARCHIVE_SEARCH_LIMIT + 1; i++) insert.run(userId, `youtube:many${i}`, JSON.stringify(clip({ externalId: `many${i}`, title: "Many" })), NOW + i);
    const found = archive.searchSaved(userId, { q: "many" });
    expect(found).toHaveLength(limits.ARCHIVE_SEARCH_LIMIT);
    expect(found[0]!.item.key).toBe(`youtube:many${limits.ARCHIVE_SEARCH_LIMIT}`);
  });
});

describe("what the scroll is told", () => {
  it("lists saved clips with a note or a collection, and nothing else", () => {
    seedAndSave(userId, [clip({ externalId: "a" }), clip({ externalId: "b" }), clip({ externalId: "c" })]);
    expect(archive.annotatedKeys(userId)).toEqual([]);
    archive.setNote(userId, "youtube:a", "noted");
    archive.addToCollection(userId, archive.createCollection(userId, "Filed").id, "youtube:b");
    expect(archive.annotatedKeys(userId).sort()).toEqual(["youtube:a", "youtube:b"]);
    archive.setNote(userId, "youtube:a", "");
    expect(archive.annotatedKeys(userId)).toEqual(["youtube:b"]);
  });

  it("carries those keys in the open feed", async () => {
    saveSettings(userId, { timezone: "UTC", windowStart: "12:00" });
    connectDemo(userId, "youtube");
    const at = Date.UTC(2026, 8, 20, 12, 30);
    const feed = await getFeed(userId, at);
    if (feed.status !== "open") throw new Error("expected the hour to be open");
    const first = feed.items[0]!;
    saveItem(userId, first.key, at);
    archive.setNote(userId, first.key, "for later");
    const again = await getFeed(userId, at);
    if (again.status !== "open") throw new Error("expected the hour to be open");
    expect(again.annotatedKeys).toEqual([first.key]);
  });
});

describe("the limits module", () => {
  it("stays a leaf, so client components can read the limits without the database", () => {
    const source = readFileSync("src/lib/archive-limits.ts", "utf8");
    expect([...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)]).toEqual([]);
  });
});
