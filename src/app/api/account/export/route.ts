/**
 * GET /api/account/export — everything the app holds about you, as a JSON download.
 * Access tokens are deliberately excluded: they are secrets belonging to the platforms,
 * and a file in your downloads folder is the wrong place for them.
 */
import { withUser } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const GET = withUser(async (_req, user) => {
  const db = getDb();
  const rows = <T,>(sql: string) => db.prepare(sql).all(user.id) as T[];
  const payload = {
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email, displayName: user.display_name, createdAt: new Date(user.created_at).toISOString() },
    settings: getSettings(user.id),
    connections: rows<Record<string, unknown>>(
      "SELECT provider, provider_user_id, display_name, demo, connected_at FROM connections WHERE user_id = ?",
    ),
    dailyFeeds: rows<Record<string, unknown>>("SELECT day_key, items_json, generated_at, opens_at, closes_at FROM daily_feeds WHERE user_id = ?").map(
      (f) => ({ ...f, items_json: undefined, feed: JSON.parse(String(f.items_json)) }),
    ),
    seenItems: rows<Record<string, unknown>>("SELECT item_key, seen_at FROM seen_items WHERE user_id = ?"),
    savedItems: rows<Record<string, unknown>>("SELECT item_key, item_json, saved_at FROM saved_items WHERE user_id = ?").map((s) => ({
      savedAt: s.saved_at,
      item: JSON.parse(String(s.item_json)),
    })),
    mutedCreators: rows<Record<string, unknown>>("SELECT provider, creator_handle, muted_at FROM muted_creators WHERE user_id = ?"),
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="daily-scroll-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
