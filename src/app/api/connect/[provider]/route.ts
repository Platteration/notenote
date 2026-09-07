import { json, withUser } from "@/lib/api";
import { connectDemo, disconnect, listConnections } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

type Ctx = { params: Promise<{ provider: string }> };

/**
 * Create a demo connection.
 *
 * This is a POST rather than a link because it changes account state, and the session
 * cookie is SameSite=Lax — which still travels on a top-level cross-site GET navigation,
 * so a link on someone else's page could otherwise add connections to a signed-in
 * account. Lax withholds the cookie from cross-site POSTs, which is what we want here.
 */
export const POST = withUser<Ctx>(async (_req, user, ctx) => {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return json({ error: "Unknown provider" }, { status: 404 });
  connectDemo(user.id, provider.id);
  return json({ connections: listConnections(user.id) });
});

export const DELETE = withUser<Ctx>(async (_req, user, ctx) => {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return json({ error: "Unknown provider" }, { status: 404 });
  disconnect(user.id, provider.id);
  return json({ connections: listConnections(user.id) });
});
