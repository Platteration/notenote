/** One collection: rename it, or delete it (its clips and their notes stay in the archive). */
import { json, readJson, withUser } from "@/lib/api";
import { deleteCollection, renameCollection } from "@/lib/archive";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withUser<Ctx>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ name?: unknown }>(req);
  return json({ collection: renameCollection(user.id, id, body.name) });
});

export const DELETE = withUser<Ctx>(async (_req, user, ctx) => {
  const { id } = await ctx.params;
  if (!deleteCollection(user.id, id)) return json({ error: "No such collection" }, { status: 404 });
  return json({ ok: true });
});
