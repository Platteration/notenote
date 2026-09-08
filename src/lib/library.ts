/**
 * The library: the parts of the product that deliberately outlive the hour.
 *
 * A hard cutoff is only tolerable if nothing good is lost forever, so saving a clip keeps
 * a copy of its metadata (not just a key) and stays reachable at any time of day. Muting a
 * creator is the other direction: an explicit "less like this" that curation respects.
 */
import { getDb, now, type DailyFeedRow } from "./db";
import type { MediaItem, ProviderId } from "./providers/types";

export interface SavedItem {
  item: MediaItem;
  savedAt: number;
}

/** Look an item up in one of the user's own frozen feeds, so clients can't inject arbitrary data. */
function findInFeeds(userId: string, itemKey: string): MediaItem | null {
  const rows = getDb()
    .prepare("SELECT * FROM daily_feeds WHERE user_id = ? ORDER BY generated_at DESC LIMIT 7")
    .all(userId) as unknown as DailyFeedRow[];
  for (const row of rows) {
    const parsed = JSON.parse(row.items_json) as { items: MediaItem[] };
    const found = parsed.items.find((i) => i.key === itemKey);
    if (found) return found;
  }
  return null;
}

export function saveItem(userId: string, itemKey: string, at: number = now()): SavedItem {
  const item = findInFeeds(userId, itemKey);
  if (!item) throw new Error("That clip isn't in any of your recent feeds");
  getDb()
    .prepare(
      `INSERT INTO saved_items (user_id, item_key, item_json, saved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, item_key) DO UPDATE SET item_json = excluded.item_json`,
    )
    .run(userId, itemKey, JSON.stringify(item), at);
  return { item, savedAt: at };
}

export function unsaveItem(userId: string, itemKey: string): void {
  getDb().prepare("DELETE FROM saved_items WHERE user_id = ? AND item_key = ?").run(userId, itemKey);
}

export function listSaved(userId: string): SavedItem[] {
  const rows = getDb()
    .prepare("SELECT item_json, saved_at FROM saved_items WHERE user_id = ? ORDER BY saved_at DESC")
    .all(userId) as Array<{ item_json: string; saved_at: number }>;
  return rows.map((r) => ({ item: JSON.parse(r.item_json) as MediaItem, savedAt: r.saved_at }));
}

export function savedKeys(userId: string): string[] {
  return (getDb().prepare("SELECT item_key FROM saved_items WHERE user_id = ?").all(userId) as Array<{ item_key: string }>).map(
    (r) => r.item_key,
  );
}

/**
 * An upper bound on muted creators. Every one is loaded into memory when a feed is built, so
 * an unbounded list would be a way to make that slow and to grow shared storage. Far above
 * anything a person would reach by muting creators they actually saw.
 */
export const MAX_MUTED_CREATORS = 500;

export function muteCreator(userId: string, provider: ProviderId, creatorHandle: string, at: number = now()): void {
  const existing = (
    getDb().prepare("SELECT COUNT(*) AS c FROM muted_creators WHERE user_id = ?").get(userId) as { c: number }
  ).c;
  if (existing >= MAX_MUTED_CREATORS) {
    throw new Error(`You can mute up to ${MAX_MUTED_CREATORS} creators. Unmute someone first.`);
  }
  getDb()
    .prepare(
      `INSERT INTO muted_creators (user_id, provider, creator_handle, muted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider, creator_handle) DO NOTHING`,
    )
    .run(userId, provider, creatorHandle.toLowerCase(), at);
}

export function unmuteCreator(userId: string, provider: string, creatorHandle: string): void {
  getDb()
    .prepare("DELETE FROM muted_creators WHERE user_id = ? AND provider = ? AND creator_handle = ?")
    .run(userId, provider, creatorHandle.toLowerCase());
}

export interface MutedCreator {
  provider: string;
  creatorHandle: string;
  mutedAt: number;
}

export function listMuted(userId: string): MutedCreator[] {
  return (
    getDb()
      .prepare("SELECT provider, creator_handle, muted_at FROM muted_creators WHERE user_id = ? ORDER BY muted_at DESC")
      .all(userId) as Array<{ provider: string; creator_handle: string; muted_at: number }>
  ).map((r) => ({ provider: r.provider, creatorHandle: r.creator_handle, mutedAt: r.muted_at }));
}

/** Set of `provider:handle` pairs the curation should skip. */
export function mutedSet(userId: string): Set<string> {
  return new Set(listMuted(userId).map((m) => `${m.provider}:${m.creatorHandle}`));
}

export interface Streak {
  /** Consecutive days, ending today or yesterday, on which the hour was opened. */
  current: number;
  longest: number;
  /** Days the hour was opened at all. */
  total: number;
}

/**
 * A streak of showing up, not of watching more. The hour is fixed either way, so this
 * can't be inflated by scrolling harder — only by keeping the ritual.
 */
export function streakFor(userId: string, todayKey: string): Streak {
  const days = (
    getDb().prepare("SELECT day_key FROM daily_feeds WHERE user_id = ? ORDER BY day_key DESC").all(userId) as Array<{
      day_key: string;
    }>
  ).map((r) => r.day_key);
  if (days.length === 0) return { current: 0, longest: 0, total: 0 };

  const set = new Set(days);
  const dayBefore = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    return prev.toISOString().slice(0, 10);
  };

  // The run may end today or yesterday; a gap of more than a day breaks it.
  let cursor = set.has(todayKey) ? todayKey : dayBefore(todayKey);
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor = dayBefore(cursor);
  }

  // Longest run: walk the days in order and count consecutive dates.
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...days].sort()) {
    run = prev !== null && dayBefore(day) === prev ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }

  return { current, longest, total: days.length };
}
