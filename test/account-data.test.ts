import { beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-account-data-tests";

const { signUp } = await import("@/lib/auth");
const { getDb, transaction } = await import("@/lib/db");
type UserRow = import("@/lib/db").UserRow;
const { buildExport, deleteAccountData } = await import("@/lib/account-data");
const { saveItem } = await import("@/lib/library");
const archive = await import("@/lib/archive");

const NOW = Date.UTC(2026, 8, 20, 12, 0);
let user: UserRow;

beforeEach(async () => {
  const created = await signUp({ email: `${crypto.randomUUID()}@example.com`, displayName: "Owner", password: "password123" });
  user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(created.id) as unknown as UserRow;
});

function seedArchive() {
  const item = {
    key: "youtube:a", provider: "youtube", externalId: "a", title: "A clip", creator: "C", creatorHandle: "c",
    permalink: "https://www.youtube.com/shorts/a", thumbnailUrl: null, videoUrl: null, durationSeconds: 30, publishedAt: NOW, metrics: {},
  };
  getDb()
    .prepare("INSERT INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(user.id, "2026-09-20", JSON.stringify({ items: [item], sources: [] }), NOW, NOW, NOW + 3_600_000);
  saveItem(user.id, "youtube:a", NOW);
  archive.setNote(user.id, "youtube:a", "watch with Sam");
  archive.addToCollection(user.id, archive.createCollection(user.id, "Cooking").id, "youtube:a");
  getDb()
    .prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, 'key-material', 'auth-secret', ?)")
    .run(`https://push.example/${user.id}`, user.id, NOW);
}

describe("the export", () => {
  it("carries the archive: notes, collections, what is filed where, and push devices", () => {
    seedArchive();
    const exported = buildExport(user);
    expect(exported.savedItems).toEqual([expect.objectContaining({ note: "watch with Sam", item: expect.objectContaining({ key: "youtube:a" }) })]);
    expect(exported.collections).toEqual([expect.objectContaining({ name: "Cooking" })]);
    expect(exported.collectionItems).toEqual([expect.objectContaining({ item_key: "youtube:a" })]);
    expect(exported.pushSubscriptions).toEqual([expect.objectContaining({ endpoint: `https://push.example/${user.id}` })]);
    const text = JSON.stringify(exported);
    for (const secret of ["password_hash", "key-material", "auth-secret", "access_token"]) expect(text).not.toContain(secret);
  });

  it("lists an unreadable saved clip or feed and carries on, instead of failing the whole export", () => {
    seedArchive();
    getDb().prepare("INSERT INTO saved_items (user_id, item_key, item_json, saved_at, note) VALUES (?, ?, ?, ?, ?)").run(user.id, "youtube:bad", "not json", NOW, "my note");
    getDb()
      .prepare("INSERT INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, "2026-09-19", "{", NOW, NOW, NOW);
    const exported = buildExport(user);
    expect(exported.savedItems).toContainEqual({ itemKey: "youtube:bad", savedAt: NOW, note: "my note", error: "unreadable" });
    expect(exported.savedItems).toContainEqual(expect.objectContaining({ note: "watch with Sam" }));
    expect(exported.dailyFeeds).toContainEqual({ dayKey: "2026-09-19", error: "unreadable" });
    expect(exported.dailyFeeds).toHaveLength(2);
  });
});

describe("deleting an account", () => {
  it("leaves nothing of it in any table", () => {
    seedArchive();
    const db = getDb();
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)").run(`t-${user.id}`, user.id, NOW + 60_000);
    db.prepare("INSERT INTO hour_opens (user_id, day_key, opened_at) VALUES (?, '2026-09-20', ?)").run(user.id, NOW);
    db.prepare("INSERT INTO scroll_visits (user_id, day_key) VALUES (?, '2026-09-18')").run(user.id);
    db.prepare("INSERT INTO muted_creators (user_id, provider, creator_handle, muted_at) VALUES (?, 'youtube', 'x', 0)").run(user.id);

    deleteAccountData(user.id);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%user_id%'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["collections", "collection_items", "saved_items", "push_subscriptions", "scroll_visits"]));
    for (const table of tables) {
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(user.id) as { c: number }).c, table).toBe(0);
    }
    expect(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)).toBeUndefined();
  });
});

describe("the deletion list", () => {
  it("names every table that holds a user's rows, rather than leaving any to a cascade", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/account-data.ts", "utf8");
    const list = /for \(const table of \[([^\]]+)\]/.exec(source)?.[1] ?? "";
    const named = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    const db = getDb();
    const withUserId = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .filter((name) => (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).some((c) => c.name === "user_id"))
      .sort();
    expect(named).toEqual(withUserId);
  });
});

describe("transactions", () => {
  it("undo every write when the work throws", () => {
    expect(() =>
      transaction(() => {
        archive.createCollection(user.id, "Half done");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(archive.listCollections(user.id)).toEqual([]);
  });

  it("run a nested call as part of the outer one", () => {
    transaction(() => transaction(() => archive.createCollection(user.id, "Nested")));
    expect(archive.listCollections(user.id).map((c) => c.name)).toEqual(["Nested"]);
  });
});
