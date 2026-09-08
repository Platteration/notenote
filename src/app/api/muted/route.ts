/**
 * "Less like this": muting a creator keeps them out of every future feed.
 */
import { json, readJson, withUser } from "@/lib/api";
import { listMuted, muteCreator, unmuteCreator } from "@/lib/library";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";

export const GET = withUser(async (_req, user) => json({ muted: listMuted(user.id) }));

export const POST = withUser(async (req, user) => {
  const body = await readJson<{ provider?: string; creatorHandle?: string }>(req);
  const provider = body.provider as ProviderId | undefined;
  if (!provider || !PROVIDER_IDS.includes(provider)) return json({ error: "Unknown platform" }, { status: 400 });
  const handle = (body.creatorHandle ?? "").trim();
  if (!handle || handle.length > 200) return json({ error: "A creator handle is required" }, { status: 400 });
  try {
    muteCreator(user.id, provider, handle);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not mute that creator" }, { status: 400 });
  }
  return json({ muted: listMuted(user.id) });
});

export const DELETE = withUser(async (req, user) => {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const handle = url.searchParams.get("creatorHandle");
  if (!provider || !handle) return json({ error: "Platform and creator handle are required" }, { status: 400 });
  unmuteCreator(user.id, provider, handle);
  return json({ muted: listMuted(user.id) });
});
