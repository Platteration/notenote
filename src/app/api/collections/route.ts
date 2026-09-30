/** The archive's collections: list them, or start one. */
import { json, readJson, withUser } from "@/lib/api";
import { createCollection, listCollections } from "@/lib/archive";

export const GET = withUser(async (_req, user) => json({ collections: listCollections(user.id) }));

export const POST = withUser(async (req, user) => {
  const body = await readJson<{ name?: unknown }>(req);
  return json({ collection: createCollection(user.id, body.name) });
});
