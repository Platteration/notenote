import { json, readJson, withUser } from "@/lib/api";
import { windowFor } from "@/lib/feed";
import { getSettings, saveSettings } from "@/lib/settings";

export const GET = withUser(async (_req, user) => json({ settings: getSettings(user.id), window: windowFor(user.id) }));

export const PUT = withUser(async (req, user) => {
  const body = await readJson<{ timezone?: string; windowStart?: string; feedSize?: number }>(req);
  const settings = saveSettings(user.id, body);
  return json({ settings, window: windowFor(user.id) });
});
