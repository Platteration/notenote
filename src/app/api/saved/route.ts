/**
 * The archive. Reachable at any hour: the scroll ends, but nothing good is lost.
 *
 * GET with no parameters lists every saved clip; with q, collection or provider it searches.
 * DELETE of a clip that has a note or sits in a collection answers 409 until confirm=1 is sent.
 */
import { errorResponse, json, readJson, withUser } from "@/lib/api";
import { searchSaved } from "@/lib/archive";
import { listSaved, saveItem, unsaveItem } from "@/lib/library";
import { UserFacingError } from "@/lib/errors";

export const GET = withUser(async (req, user) => {
  const params = new URL(req.url).searchParams;
  const q = params.get("q");
  const collectionId = params.get("collection");
  const provider = params.get("provider");
  if (q === null && collectionId === null && provider === null) return json({ saved: listSaved(user.id) });
  return json({ saved: searchSaved(user.id, { q: q ?? undefined, collectionId: collectionId ?? undefined, provider: provider ?? undefined }) });
});

export const POST = withUser(async (req, user) => {
  const body = await readJson<{ key?: string }>(req);
  if (typeof body.key !== "string" || !body.key) return json({ error: "A clip key is required" }, { status: 400 });
  try {
    const saved = saveItem(user.id, body.key);
    return json({ saved });
  } catch (err) {
    return errorResponse(err);
  }
});

export const DELETE = withUser(async (req, user) => {
  const params = new URL(req.url).searchParams;
  const key = params.get("key");
  if (!key) return json({ error: "A clip key is required" }, { status: 400 });
  try {
    unsaveItem(user.id, key, { confirmed: params.get("confirm") === "1" });
  } catch (err) {
    if (err instanceof UserFacingError && err.status === 409) return json({ error: err.message, needsConfirm: true }, { status: 409 });
    return errorResponse(err);
  }
  return json({ ok: true });
});
