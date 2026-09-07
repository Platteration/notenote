/**
 * The saved shelf. Reachable at any hour: the scroll ends, but nothing good is lost.
 */
import { json, readJson, withUser } from "@/lib/api";
import { listSaved, saveItem, unsaveItem } from "@/lib/library";

export const GET = withUser(async (_req, user) => json({ saved: listSaved(user.id) }));

export const POST = withUser(async (req, user) => {
  const body = await readJson<{ key?: string }>(req);
  if (typeof body.key !== "string" || !body.key) return json({ error: "A clip key is required" }, { status: 400 });
  try {
    const saved = saveItem(user.id, body.key);
    return json({ saved });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not save" }, { status: 400 });
  }
});

export const DELETE = withUser(async (req, user) => {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return json({ error: "A clip key is required" }, { status: 400 });
  unsaveItem(user.id, key);
  return json({ ok: true });
});
