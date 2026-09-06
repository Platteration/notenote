/**
 * The daily feed: generated once per local day, frozen for the whole hour, then gone.
 */
import { collectItems } from "./connections";
import { curate } from "./curation";
import { getDb, now, type DailyFeedRow } from "./db";
import type { MediaItem } from "./providers/types";
import { getSettings } from "./settings";
import { computeWindow, type DailyWindow } from "./window";

export interface FeedPayload {
  status: "open";
  window: DailyWindow;
  dayKey: string;
  generatedAt: number;
  items: MediaItem[];
  seenKeys: string[];
  sources: Array<{ provider: string; count: number; error: string | null }>;
}

export interface LockedPayload {
  status: "locked";
  window: DailyWindow;
  connectedCount: number;
}

export function windowFor(userId: string, at: number = now()): DailyWindow {
  const s = getSettings(userId);
  return computeWindow(at, s.timezone, s.windowStart);
}

export async function getFeed(userId: string, at: number = now()): Promise<FeedPayload | LockedPayload> {
  const settings = getSettings(userId);
  const win = computeWindow(at, settings.timezone, settings.windowStart);
  const db = getDb();

  if (!win.isOpen) {
    const connectedCount = (db.prepare("SELECT COUNT(*) AS c FROM connections WHERE user_id = ?").get(userId) as { c: number }).c;
    return { status: "locked", window: win, connectedCount };
  }

  const existing = db
    .prepare("SELECT * FROM daily_feeds WHERE user_id = ? AND day_key = ?")
    .get(userId, win.dayKey) as DailyFeedRow | undefined;

  let items: MediaItem[];
  let generatedAt: number;
  let sources: FeedPayload["sources"];

  if (existing) {
    const parsed = JSON.parse(existing.items_json) as { items: MediaItem[]; sources: FeedPayload["sources"] };
    items = parsed.items;
    sources = parsed.sources;
    generatedAt = existing.generated_at;
  } else {
    const results = await collectItems(userId, at);
    const seen = new Set(
      (db.prepare("SELECT item_key FROM seen_items WHERE user_id = ?").all(userId) as Array<{ item_key: string }>).map(
        (r) => r.item_key,
      ),
    );
    const curated = curate(
      results.flatMap((r) => r.items),
      { size: settings.feedSize, seed: `${userId}:${win.dayKey}`, now: at, seenKeys: seen },
    );
    items = curated.items;
    sources = results.map((r) => ({ provider: r.provider, count: curated.stats.perProvider[r.provider] ?? 0, error: r.error }));
    generatedAt = at;
    db.prepare(
      `INSERT INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day_key) DO NOTHING`,
    ).run(userId, win.dayKey, JSON.stringify({ items, sources }), generatedAt, win.opensAt, win.closesAt);
  }

  const seenToday = (
    db
      .prepare("SELECT item_key FROM seen_items WHERE user_id = ? AND seen_at >= ?")
      .all(userId, win.opensAt) as Array<{ item_key: string }>
  ).map((r) => r.item_key);

  return { status: "open", window: win, dayKey: win.dayKey, generatedAt, items, seenKeys: seenToday, sources };
}

export function markSeen(userId: string, itemKeys: string[], at: number = now()): number {
  const db = getDb();
  const stmt = db.prepare("INSERT OR IGNORE INTO seen_items (user_id, item_key, seen_at) VALUES (?, ?, ?)");
  let n = 0;
  for (const key of itemKeys) {
    if (typeof key !== "string" || key.length > 200) continue;
    stmt.run(userId, key, at);
    n++;
  }
  return n;
}

/** Remove feeds from previous days so nothing lingers past its hour. */
export function purgeExpiredFeeds(at: number = now()): void {
  getDb().prepare("DELETE FROM daily_feeds WHERE closes_at < ?").run(at - 86_400_000);
}
