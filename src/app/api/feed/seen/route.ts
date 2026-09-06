import { json, readJson, withUser } from "@/lib/api";
import { markSeen, windowFor } from "@/lib/feed";

export const POST = withUser(async (req, user) => {
  const win = windowFor(user.id);
  if (!win.isOpen) return json({ error: "The scroll is closed" }, { status: 423 });
  const body = await readJson<{ keys?: string[] }>(req);
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
  return json({ marked: markSeen(user.id, keys) });
});
