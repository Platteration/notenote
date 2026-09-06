/**
 * POST /api/connect/:provider/credentials
 * Connects a platform that authenticates with user-supplied credentials (e.g. a Bluesky
 * app password). The credentials are used once to open a session and are not stored;
 * only the resulting session tokens are, encrypted.
 */
import { json, readJson, withUser } from "@/lib/api";
import { listConnections, saveConnection } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

type Ctx = { params: Promise<{ provider: string }> };

export const POST = withUser<Ctx>(async (req, user, ctx) => {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return json({ error: "Unknown provider" }, { status: 404 });
  if (!provider.credentialConnect) return json({ error: `${provider.name} connects through OAuth` }, { status: 400 });
  const body = await readJson<Record<string, unknown>>(req);
  const input: Record<string, string> = {};
  for (const f of provider.credentialConnect.fields) {
    const v = body[f.name];
    if (typeof v === "string") input[f.name] = v.slice(0, 500);
    else if (f.required) return json({ error: `${f.label} is required` }, { status: 400 });
  }
  try {
    const tokens = await provider.credentialConnect.authenticate(input);
    saveConnection(user.id, provider.id, tokens, false);
    return json({ connections: listConnections(user.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not connect";
    return json({ error: message }, { status: 400 });
  }
});
