/**
 * DELETE /api/account — permanently delete the signed-in account and everything attached
 * to it: connections and their tokens, cached items, feeds, seen history and settings.
 */
import { json, readJson, withUser } from "@/lib/api";
import { getDb } from "@/lib/db";
import { destroySession } from "@/lib/session";

export const DELETE = withUser(async (req, user) => {
  const body = await readJson<{ confirm?: string }>(req).catch(() => ({ confirm: undefined }));
  if (body.confirm !== user.email) {
    return json({ error: "Type your email address to confirm deletion" }, { status: 400 });
  }
  const db = getDb();
  for (const table of ["sessions", "settings", "connections", "daily_feeds", "seen_items", "saved_items", "muted_creators"]) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
  }
  db.prepare("DELETE FROM provider_cache WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM oauth_states WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  await destroySession();
  return json({ deleted: true });
});
