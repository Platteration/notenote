/**
 * GET /api/connect/:provider/callback?code=...&state=...
 * Completes OAuth: validates state, exchanges the code, stores encrypted tokens.
 */
import { NextResponse } from "next/server";
import { saveConnection } from "@/lib/connections";
import { getDb, now } from "@/lib/db";
import { appBaseUrl, credentialsFor, getProvider } from "@/lib/providers";
import { currentUser } from "@/lib/session";

type Ctx = { params: Promise<{ provider: string }> };

function back(params: Record<string, string>): NextResponse {
  const u = new URL(`${appBaseUrl()}/connect`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString());
}

export async function GET(req: Request, ctx: Ctx) {
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return back({ error: "unknown-provider" });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied) return back({ error: `${provider.id}-denied` });
  if (!code || !state) return back({ error: `${provider.id}-missing-code` });

  const user = await currentUser();
  if (!user) return NextResponse.redirect(`${appBaseUrl()}/?next=/connect`);

  const db = getDb();
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as
    | { state: string; user_id: string; provider: string; code_verifier: string | null; created_at: number }
    | undefined;
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (!row || row.user_id !== user.id || row.provider !== provider.id || now() - row.created_at > 15 * 60 * 1000) {
    return back({ error: `${provider.id}-bad-state` });
  }

  const creds = credentialsFor(provider);
  if (!creds) return back({ error: `${provider.id}-not-configured` });

  try {
    const tokens = await provider.exchangeCode(creds, code, row.code_verifier);
    saveConnection(user.id, provider.id, tokens, false);
    return back({ connected: provider.id });
  } catch (err) {
    console.error(`[connect:${provider.id}]`, err);
    return back({ error: `${provider.id}-exchange-failed` });
  }
}
