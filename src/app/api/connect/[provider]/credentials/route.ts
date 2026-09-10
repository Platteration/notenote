/**
 * POST /api/connect/:provider/credentials
 * Connects a platform that authenticates with user-supplied credentials (e.g. a Bluesky
 * app password). The credentials are used once to open a session and are not stored;
 * only the resulting session tokens are, encrypted.
 */
import { json, readJson, withUser } from "@/lib/api";
import { UserFacingError } from "@/lib/errors";
import { listConnections, saveConnection } from "@/lib/connections";
import { getProvider } from "@/lib/providers";
import { rateLimit } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ provider: string }> };

export const POST = withUser<Ctx>(async (req, user, ctx) => {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return json({ error: "Unknown provider" }, { status: 404 });
  if (!provider.credentialConnect) return json({ error: `${provider.name} connects through OAuth` }, { status: 400 });
  // These calls carry a third-party app password; throttle so this cannot be used to
  // guess credentials against the platform on someone else's behalf.
  const limited = rateLimit(`credconnect:${user.id}:${provider.id}`, 10, 15 * 60_000);
  if (!limited.ok) {
    return json(
      { error: "Too many connection attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }
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
    // The platform's own explanation ("invalid identifier or password") helps and is safe to
    // repeat. Anything else — a blocked host, an HTTP error carrying part of an upstream body
    // — describes the server's network rather than the credentials, so it stays in the log.
    if (err instanceof UserFacingError) return json({ error: err.message }, { status: 400 });
    console.error(`Credential connect failed for ${provider.id}:`, err);
    return json({ error: `Could not connect ${provider.name}. Check the details and try again.` }, { status: 400 });
  }
});
