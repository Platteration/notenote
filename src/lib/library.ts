/**
 * The library: the parts of the product that deliberately outlive the hour.
 *
 * A hard cutoff is only tolerable if nothing good is lost forever, so saving a clip keeps
 * a copy of its metadata (not just a key) and stays reachable at any time of day. Saved clips
 * are the archive, which src/lib/archive.ts adds notes, collections and search to. Muting a
 * creator is the other direction: an explicit "less like this" that curation respects.
 */
import { MAX_SAVED_ITEMS } from "./archive-limits";
import { getDb, now, type DailyFeedRow } from "./db";
import { UserFacingError } from "./errors";
import type { MediaItem, ProviderId } from "./providers/types";

export interface SavedItem {
  item: MediaItem;
  savedAt: number;
  /** The user's own note on the clip; empty when there is none. */
  note: string;
  /** Ids of the collections the clip is filed in. */
  collections: string[];
}

/** A saved_items row as the archive reads it. */
export interface SavedRow {
  item_key: string;
  item_json: string;
  saved_at: number;
  note: string;
}

/**
 * Rows to SavedItems, with each clip's collections attached. A row whose stored copy cannot be
 * read is left out rather than failing the whole shelf: one bad row must not hide the rest.
 */
export function hydrateSaved(userId: string, rows: SavedRow[]): SavedItem[] {
  const memberships = new Map<string, string[]>();
  for (const m of getDb().prepare("SELECT collection_id, item_key FROM collection_items WHERE user_id = ?").all(userId) as Array<{
    collection_id: string;
    item_key: string;
  }>) {
    const list = memberships.get(m.item_key) ?? [];
    list.push(m.collection_id);
    memberships.set(m.item_key, list);
  }
  const out: SavedItem[] = [];
  for (const r of rows) {
    let item: MediaItem;
    try {
      item = JSON.parse(r.item_json) as MediaItem;
    } catch {
      continue;
    }
    out.push({ item, savedAt: r.saved_at, note: r.note, collections: memberships.get(r.item_key) ?? [] });
  }
  return out;
}

/** One saved clip, or null when it is not in this user's archive. */
export function readSaved(userId: string, itemKey: string): SavedItem | null {
  const row = getDb()
    .prepare("SELECT item_key, item_json, saved_at, note FROM saved_items WHERE user_id = ? AND item_key = ?")
    .get(userId, itemKey) as SavedRow | undefined;
  return row ? (hydrateSaved(userId, [row])[0] ?? null) : null;
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
  if (!item) throw new UserFacingError("That clip isn't in any of your recent feeds");
  const db = getDb();
  // Only a new clip counts toward the cap; saving one already kept refreshes its copy.
  if (!db.prepare("SELECT 1 FROM saved_items WHERE user_id = ? AND item_key = ?").get(userId, itemKey)) {
    const count = (db.prepare("SELECT COUNT(*) AS c FROM saved_items WHERE user_id = ?").get(userId) as { c: number }).c;
    if (count >= MAX_SAVED_ITEMS) throw new UserFacingError(`Your archive holds up to ${MAX_SAVED_ITEMS} clips. Remove some first.`);
  }
  // On a clip already saved only its copy is refreshed, so its note and collections stay.
  db
    .prepare(
      `INSERT INTO saved_items (user_id, item_key, item_json, saved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, item_key) DO UPDATE SET item_json = excluded.item_json`,
    )
    .run(userId, itemKey, JSON.stringify(item), at);
  return readSaved(userId, itemKey)!;
}

/**
 * Removing a clip that carries the user's own writing — a note, or a place in a collection —
 * needs `confirmed`. Without it the clip stays and this answers 409, so a tap on a stale tab or
 * another device cannot delete a note it never showed. A plain saved clip goes straight away.
 */
export function unsaveItem(userId: string, itemKey: string, { confirmed = false }: { confirmed?: boolean } = {}): void {
  const db = getDb();
  if (!confirmed) {
    const annotated = db
      .prepare(
        `SELECT 1 FROM saved_items WHERE user_id = ? AND item_key = ?
           AND (note <> '' OR EXISTS (SELECT 1 FROM collection_items WHERE user_id = ? AND item_key = ?))`,
      )
      .get(userId, itemKey, userId, itemKey);
    if (annotated) throw new UserFacingError("This clip has a note or is in a collection. Confirm to remove it and its note.", 409);
  }
  // Its collection memberships go with it (ON DELETE CASCADE); the note is part of the row.
  db.prepare("DELETE FROM saved_items WHERE user_id = ? AND item_key = ?").run(userId, itemKey);
}

export function listSaved(userId: string): SavedItem[] {
  const rows = getDb()
    .prepare("SELECT item_key, item_json, saved_at, note FROM saved_items WHERE user_id = ? ORDER BY saved_at DESC")
    .all(userId) as unknown as SavedRow[];
  return hydrateSaved(userId, rows);
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
    throw new UserFacingError(`You can mute up to ${MAX_MUTED_CREATORS} creators. Unmute someone first.`);
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

/**
 * Record that the user was here while their hour was open.
 *
 * Deliberately separate from daily_feeds: that table is the frozen feed and is swept a day
 * after the hour closes, whereas showing up is a fact worth keeping. Called on every request
 * inside the window, not only the one that generates the feed, so a day still counts when the
 * feed was already built.
 */
export function recordHourOpen(userId: string, dayKey: string, at: number = now()): void {
  getDb()
    .prepare("INSERT INTO hour_opens (user_id, day_key, opened_at) VALUES (?, ?, ?) ON CONFLICT(user_id, day_key) DO NOTHING")
    .run(userId, dayKey, at);
}

export interface Streak {
  /** Consecutive days, ending today or yesterday, on which the hour was opened. */
  current: number;
  longest: number;
  /** Days the hour was opened at all. */
  total: number;
}

/** The `YYYY-MM-DD` key of the day before `key`, or null when `key` is not a date. */
function dayBefore(key: string): string | null {
  const [y, m, d] = key.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return Number.isNaN(prev.getTime()) ? null : prev.toISOString().slice(0, 10);
}

/**
 * A streak of showing up, not of watching more. The hour is fixed either way, so this
 * can't be inflated by scrolling harder — only by keeping the ritual.
 */
export function streakFor(userId: string, todayKey: string): Streak {
  // Counted from hour_opens, not daily_feeds: the housekeeping sweep drops a feed a day
  // after its hour closes, so a streak read from those rows could never pass two.
  // A row whose key is not a date sits in no run, so it is left out rather than allowed to
  // throw: this is read on every request while the hour is shut, and one such row would
  // otherwise fail each of them for as long as the row is there.
  const days = (
    getDb().prepare("SELECT day_key FROM hour_opens WHERE user_id = ? ORDER BY day_key DESC").all(userId) as Array<{
      day_key: string;
    }>
  )
    .map((r) => r.day_key)
    .filter((key) => dayBefore(key) !== null);
  if (days.length === 0) return { current: 0, longest: 0, total: 0 };

  const set = new Set(days);

  // The run may end today or yesterday; a gap of more than a day breaks it.
  let cursor = set.has(todayKey) ? todayKey : dayBefore(todayKey);
  let current = 0;
  while (cursor !== null && set.has(cursor)) {
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
