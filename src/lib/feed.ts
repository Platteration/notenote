/**
 * The daily feed: generated once per local day, frozen for the whole hour, then gone.
 */
import { collectItems } from "./connections";
import { curate } from "./curation";
import { getDb, now, type DailyFeedRow } from "./db";
import type { MediaItem } from "./providers/types";
import { mutedSet, recordHourOpen, savedKeys, streakFor, type Streak } from "./library";
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

  // The hour is open and the user is here: that is what a streak counts, so it is recorded
  // before anything else can fail, and on every open request rather than only the first.
  recordHourOpen(userId, win.dayKey, at);

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

/**
 * Record which clips were watched.
 *
 * Only keys that are actually in one of the user's own recent feeds are accepted. Anything
 * else is not a clip they could have seen, and taking arbitrary strings would let a caller
 * grow this table without limit — which matters because every key is loaded into memory on
 * each feed generation to filter out repeats.
 */
export function markSeen(userId: string, itemKeys: string[], at: number = now()): number {
  const db = getDb();
  const known = new Set<string>();
  const feeds = db
    .prepare("SELECT items_json FROM daily_feeds WHERE user_id = ? ORDER BY generated_at DESC LIMIT 3")
    .all(userId) as Array<{ items_json: string }>;
  for (const row of feeds) {
    for (const item of (JSON.parse(row.items_json) as { items: MediaItem[] }).items) known.add(item.key);
  }

  const stmt = db.prepare("INSERT OR IGNORE INTO seen_items (user_id, item_key, seen_at) VALUES (?, ?, ?)");
  let n = 0;
  for (const key of itemKeys) {
    if (typeof key !== "string" || !known.has(key)) continue;
    stmt.run(userId, key, at);
    n++;
  }
  return n;
}

/** How often the housekeeping sweep is worth running. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurge = 0;

export interface PurgeCounts {
  feeds: number;
  sessions: number;
  oauthStates: number;
}

/**
 * Housekeeping. Expired sessions and abandoned OAuth handshakes were accumulating with
 * nothing to remove them; feeds are dropped a day after their hour so nothing lingers.
 */
export function purgeExpired(at: number = now()): PurgeCounts {
  const db = getDb();
  const feeds = db.prepare("DELETE FROM daily_feeds WHERE closes_at < ?").run(at - 86_400_000);
  const sessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(at);
  const states = db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(at - 15 * 60 * 1000);
  return {
    feeds: Number(feeds.changes),
    sessions: Number(sessions.changes),
    oauthStates: Number(states.changes),
  };
}

/** Called on ordinary requests, so it does its work at most once an hour. */
export function purgeExpiredIfDue(at: number = now()): PurgeCounts | null {
  if (at - lastPurge < PURGE_INTERVAL_MS) return null;
  lastPurge = at;
  return purgeExpired(at);
}

/** Only for tests. */
export function resetPurgeSchedule(): void {
  lastPurge = 0;
}
