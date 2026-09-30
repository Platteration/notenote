/**
 * What the app holds about one account: the export that hands it over, and the deletion that
 * removes it. Kept out of the route handlers so both can be tested without a request.
 */
import { getDb, transaction, type UserRow } from "./db";
import { getSettings } from "./settings";

/**
 * Everything the app holds about you, as one JSON document. Access tokens are deliberately
 * excluded: they are secrets belonging to the platforms, and a file in your downloads folder is
 * the wrong place for them. So are a push subscription's keys, which only the browser needs.
 *
 * A safety net degrades rather than refuses: a stored feed or saved clip whose copy cannot be
 * read is listed with `error: "unreadable"` (and a saved clip keeps its note, which is the
 * user's own writing), and the rest of the export goes ahead.
 */
export function buildExport(user: UserRow) {
  const db = getDb();
  const rows = <T,>(sql: string) => db.prepare(sql).all(user.id) as T[];
  const parse = (text: unknown): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(String(text)) };
    } catch {
      return { ok: false };
    }
  };
  return {
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email, displayName: user.display_name, createdAt: new Date(user.created_at).toISOString() },
    settings: getSettings(user.id),
    connections: rows<Record<string, unknown>>(
      "SELECT provider, provider_user_id, display_name, demo, connected_at FROM connections WHERE user_id = ?",
    ),
    dailyFeeds: rows<Record<string, unknown>>("SELECT day_key, items_json, generated_at, opens_at, closes_at FROM daily_feeds WHERE user_id = ?").map(
      (f) => {
        const feed = parse(f.items_json);
        return feed.ok ? { ...f, items_json: undefined, feed: feed.value } : { dayKey: f.day_key, error: "unreadable" };
      },
    ),
    hourOpens: rows<Record<string, unknown>>("SELECT day_key, opened_at FROM hour_opens WHERE user_id = ? ORDER BY day_key"),
    seenItems: rows<Record<string, unknown>>("SELECT item_key, seen_at FROM seen_items WHERE user_id = ?"),
    savedItems: rows<Record<string, unknown>>("SELECT item_key, item_json, saved_at, note FROM saved_items WHERE user_id = ?").map((s) => {
      const item = parse(s.item_json);
      return item.ok
        ? { savedAt: s.saved_at, note: s.note, item: item.value }
        : { itemKey: s.item_key, savedAt: s.saved_at, note: s.note, error: "unreadable" };
    }),
    collections: rows<Record<string, unknown>>("SELECT id, name, created_at FROM collections WHERE user_id = ? ORDER BY created_at"),
    collectionItems: rows<Record<string, unknown>>("SELECT collection_id, item_key, added_at FROM collection_items WHERE user_id = ?"),
    mutedCreators: rows<Record<string, unknown>>("SELECT provider, creator_handle, muted_at FROM muted_creators WHERE user_id = ?"),
    pushSubscriptions: rows<Record<string, unknown>>("SELECT endpoint, created_at, last_open_day FROM push_subscriptions WHERE user_id = ?"),
  };
}

/**
 * Delete the account and everything attached to it, all or nothing: connections and their
 * tokens, cached items, feeds, visit history, seen history, the archive (saved clips, notes,
 * collections), mutes, push subscriptions, settings and sessions. Every table is named rather
 * than left to cascades, so the list says what goes.
 */
export function deleteAccountData(userId: string): void {
  const db = getDb();
  transaction(() => {
    for (const table of [
      "sessions",
      "settings",
      "connections",
      "daily_feeds",
      "hour_opens",
      "scroll_visits",
      "seen_items",
      "collection_items",
      "collections",
      "saved_items",
      "muted_creators",
      "push_subscriptions",
      "provider_cache",
      "oauth_states",
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
}
