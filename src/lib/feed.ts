/**
 * The daily feed: generated once per local day, frozen for the whole hour, then gone.
 */
import { collectItems } from "./connections";
import { curate, type CurationReason } from "./curation";
import { getDb, now, type DailyFeedRow } from "./db";
import type { MediaItem } from "./providers/types";
import { mutedSet, savedKeys, streakFor, type Streak } from "./library";
import { enabledProviderIds } from "./providers";
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
  mutedCreators: string[];
  sources: Array<{ provider: string; count: number; error: string | null }>;
  /**
   * Why each clip was chosen, keyed by item key. Empty for feeds frozen before this was
   * recorded, which the UI treats as "no explanation available" rather than an error.
   */
  reasons: Record<string, CurationReason>;
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
  const started = now();
  const settings = getSettings(userId);
  const win = computeWindow(at, settings.timezone, settings.windowStart);
  const db = getDb();

  if (!win.isOpen) {
    const enabled = new Set<string>(enabledProviderIds());
    const connectedCount = (db.prepare("SELECT provider FROM connections WHERE user_id = ?").all(userId) as Array<{ provider: string }>).filter((r) => enabled.has(r.provider)).length;
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
  let reasons: Record<string, CurationReason>;

  if (existing && (JSON.parse(existing.items_json) as { items: MediaItem[] }).items.length > 0) {
    const parsed = JSON.parse(existing.items_json) as {
      items: MediaItem[];
      sources: FeedPayload["sources"];
      reasons?: Record<string, CurationReason>;
    };
    items = parsed.items;
    sources = parsed.sources;
    // Feeds frozen before explanations existed simply have none.
    reasons = parsed.reasons ?? {};
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
    reasons = curated.reasons;
    sources = results.map((r) => ({ provider: r.provider, count: curated.stats.perProvider[r.provider] ?? 0, error: r.error }));
    generatedAt = at;
    // Only freeze a useful feed. A first visit before connecting, or a temporary
    // provider outage, must not prevent recovery for the rest of the day.
    if (items.length > 0) db.prepare(
      `INSERT INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day_key) DO UPDATE SET items_json = excluded.items_json,
         generated_at = excluded.generated_at, opens_at = excluded.opens_at, closes_at = excluded.closes_at
       WHERE json_array_length(daily_feeds.items_json, '$.items') = 0`,
    ).run(userId, win.dayKey, JSON.stringify({ items, sources, reasons }), generatedAt, win.opensAt, win.closesAt);
    // Concurrent first requests must return the same winner that was persisted.
    const winner = db.prepare("SELECT * FROM daily_feeds WHERE user_id = ? AND day_key = ?").get(userId, win.dayKey) as DailyFeedRow | undefined;
    if (winner) {
      const frozen = JSON.parse(winner.items_json) as { items: MediaItem[]; sources: FeedPayload["sources"]; reasons?: Record<string, CurationReason> };
      items = frozen.items;
      sources = frozen.sources;
      reasons = frozen.reasons ?? {};
      generatedAt = winner.generated_at;
    }
  }

  // Recheck after provider I/O: a request started before closing may finish after it.
  const finishedAt = at + Math.max(0, now() - started);
  const currentWindow = windowFor(userId, finishedAt);
  if (!currentWindow.isOpen || currentWindow.dayKey !== win.dayKey) return getFeed(userId, finishedAt);
  db.prepare("INSERT OR IGNORE INTO scroll_visits (user_id, day_key) VALUES (?, ?)").run(userId, win.dayKey);

  const seenToday = (
    db
      .prepare("SELECT item_key FROM seen_items WHERE user_id = ? AND seen_at >= ?")
      .all(userId, win.opensAt) as Array<{ item_key: string }>
  ).map((r) => r.item_key);

  return {
    status: "open",
    window: currentWindow,
    dayKey: win.dayKey,
    generatedAt,
    items,
    seenKeys: seenToday,
    savedKeys: savedKeys(userId),
    mutedCreators: [...mutedSet(userId)],
    sources,
    reasons,
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
  db.exec("INSERT OR IGNORE INTO scroll_visits (user_id, day_key) SELECT user_id, day_key FROM daily_feeds");
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
