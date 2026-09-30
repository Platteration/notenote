/** File a saved clip in a collection, or take it out. */
import { json, readJson, withUser } from "@/lib/api";
import { addToCollection, removeFromCollection } from "@/lib/archive";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser<Ctx>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ key?: unknown }>(req);
  if (typeof body.key !== "string" || !body.key) return json({ error: "A clip key is required" }, { status: 400 });
  return json({ saved: addToCollection(user.id, id, body.key) });
});

export const DELETE = withUser<Ctx>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return json({ error: "A clip key is required" }, { status: 400 });
  return json({ saved: removeFromCollection(user.id, id, key) });
});
