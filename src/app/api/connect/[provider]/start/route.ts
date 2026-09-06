/**
 * GET /api/connect/:provider/start
 * Begins the OAuth dance. When the platform has no credentials configured, a demo
 * connection is created instead so the product stays explorable.
 */
import { NextResponse } from "next/server";
import { connectDemo } from "@/lib/connections";
import { pkceChallenge, pkceVerifier, randomToken } from "@/lib/crypto";
import { getDb, now } from "@/lib/db";
import { appBaseUrl, credentialsFor, getProvider } from "@/lib/providers";
import { currentUser } from "@/lib/session";

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(`${appBaseUrl()}/?next=/connect`);
  const { provider: id } = await ctx.params;
  const provider = getProvider(id);
  if (!provider) return NextResponse.redirect(`${appBaseUrl()}/connect?error=unknown-provider`);

  const creds = credentialsFor(provider);
  if (!creds) {
    connectDemo(user.id, provider.id);
    return NextResponse.redirect(`${appBaseUrl()}/connect?connected=${provider.id}&demo=1`);
  }

  const state = randomToken(24);
  const verifier = provider.usesPkce ? pkceVerifier() : null;
  const db = getDb();
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(now() - 15 * 60 * 1000);
  db.prepare("INSERT INTO oauth_states (state, user_id, provider, code_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run(
    state,
    user.id,
    provider.id,
    verifier,
    now(),
  );
  const url = provider.buildAuthorizeUrl(creds, {
    state,
    codeChallenge: verifier ? pkceChallenge(verifier) : "",
  });
  return NextResponse.redirect(url);
}
