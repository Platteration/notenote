import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A database written by an earlier build, opened by this one through the real start-up path:
 * the file is made on disk first, then getDb() finds it and migrates it.
 */
const dir = mkdtempSync(path.join(tmpdir(), "daily-scroll-migration-"));
delete process.env.DATABASE_FILE;
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-for-migration-tests";

const old = new DatabaseSync(path.join(dir, "daily-scroll.db"));
old.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE saved_items (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_key TEXT NOT NULL, item_json TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY (user_id, item_key));
  CREATE TABLE scroll_visits (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day_key TEXT NOT NULL, PRIMARY KEY (user_id, day_key));
  INSERT INTO users VALUES ('u1', 'old@example.com', 'Old', 'x', 0);
  INSERT INTO saved_items VALUES ('u1', 'youtube:old', '{"key":"youtube:old","title":"Saved long ago"}', 1);
  INSERT INTO scroll_visits VALUES ('u1', '2026-09-01'), ('u1', '2026-09-02');
`);
old.close();

const { getDb } = await import("@/lib/db");
const { listSaved } = await import("@/lib/library");

afterAll(() => {
  getDb().close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opening a database from an earlier build", () => {
  it("gives every saved clip an empty note, keeping the clips", () => {
    const columns = (getDb().prepare("PRAGMA table_info(saved_items)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("note");
    expect(listSaved("u1")).toEqual([expect.objectContaining({ note: "", collections: [], item: expect.objectContaining({ key: "youtube:old" }) })]);
  });

  it("carries the old visit ledger into hour_opens, stamped at midnight UTC of each day", () => {
    const rows = getDb().prepare("SELECT day_key, opened_at FROM hour_opens WHERE user_id = 'u1' ORDER BY day_key").all();
    expect(rows).toEqual([
      { day_key: "2026-09-01", opened_at: Date.UTC(2026, 8, 1) },
      { day_key: "2026-09-02", opened_at: Date.UTC(2026, 8, 2) },
    ]);
    // The old table is kept, not dropped: its rows are the only record of those visits.
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM scroll_visits").get()).toEqual({ c: 2 });
  });
});
