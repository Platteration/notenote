/** PATCH /api/saved/note — set or clear the note on one saved clip. */
import { json, readJson, withUser } from "@/lib/api";
import { setNote } from "@/lib/archive";

export const PATCH = withUser(async (req, user) => {
  const body = await readJson<{ key?: unknown; note?: unknown }>(req);
  if (typeof body.key !== "string" || !body.key) return json({ error: "A clip key is required" }, { status: 400 });
  if (typeof body.note !== "string") return json({ error: "A note must be text" }, { status: 400 });
  return json({ saved: setNote(user.id, body.key, body.note) });
});
