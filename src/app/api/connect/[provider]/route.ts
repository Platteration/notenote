import { json, withUser } from "@/lib/api";
import { disconnect, listConnections } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

type Ctx = { params: Promise<{ provider: string }> };

export const DELETE = withUser<Ctx>(async (_req, user, ctx) => {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return json({ error: "Unknown provider" }, { status: 404 });
  disconnect(user.id, provider.id);
  return json({ connections: listConnections(user.id) });
});
