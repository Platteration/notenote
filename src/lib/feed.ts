/**
 * The daily feed: generated once per local day, frozen for the whole hour, then gone.
 */
import { collectItems } from "./connections";
import { curate } from "./curation";
import { getDb, now, type DailyFeedRow } from "./db";
import type { MediaItem } from "./providers/types";
import { mutedSet, savedKeys, streakFor, type Streak } from "./library";
import { getSettings } from "./settings";
import { computeWindow, type DailyWindow } from "./window";

export interface FeedPayload {
  status: "open";
  window: DailyWindow;
  dayKey: string;
  generatedAt: number;
  items: MediaItem[];
  seenKeys: string[];
  savedKeys: string[];
  sources: Array<{ provider: string; count: number; error: string | null }>;
}

export interface HourRecap {
  dayKey: string;
  closedAt: number;
  total: number;
  watched: number;
  perProvider: Record<string, number>;
}

export interface LockedPayload {
  status: "locked";
  window: DailyWindow;
  connectedCount: number;
  /** What happened during the most recent hour, if the user opened it. */
  recap: HourRecap | null;
  streak: Streak;
  savedCount: number;
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
    return {
      status: "locked",
      window: win,
      connectedCount,
      recap: lastRecap(userId, at),
      streak: streakFor(userId, win.dayKey),
      savedCount: savedKeys(userId).length,
    };
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
      { size: settings.feedSize, seed: `${userId}:${win.dayKey}`, now: at, seenKeys: seen, mutedCreators: mutedSet(userId) },
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

  return {
    status: "open",
    window: win,
    dayKey: win.dayKey,
    generatedAt,
    items,
    seenKeys: seenToday,
    savedKeys: savedKeys(userId),
    sources,
  };
}

/** Summary of the most recently closed hour (within the last two days). */
export function lastRecap(userId: string, at: number = now()): HourRecap | null {
  const row = getDb()
    .prepare("SELECT * FROM daily_feeds WHERE user_id = ? AND closes_at <= ? ORDER BY closes_at DESC LIMIT 1")
    .get(userId, at) as DailyFeedRow | undefined;
  if (!row || at - row.closes_at > 2 * 86_400_000) return null;
  const parsed = JSON.parse(row.items_json) as { items: MediaItem[] };
  const watched = (
    getDb()
      .prepare("SELECT item_key FROM seen_items WHERE user_id = ? AND seen_at >= ? AND seen_at < ?")
      .all(userId, row.opens_at, row.closes_at) as Array<{ item_key: string }>
  ).map((r) => r.item_key);
  const inFeed = new Set(parsed.items.map((i) => i.key));
  const perProvider: Record<string, number> = {};
  for (const it of parsed.items) {
    if (watched.includes(it.key)) perProvider[it.provider] = (perProvider[it.provider] ?? 0) + 1;
  }
  return {
    dayKey: row.day_key,
    closedAt: row.closes_at,
    total: parsed.items.length,
    watched: watched.filter((k) => inFeed.has(k)).length,
    perProvider,
  };
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
