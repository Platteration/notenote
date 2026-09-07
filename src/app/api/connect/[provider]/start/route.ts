/**
 * GET /api/connect/:provider/start
 * Begins the OAuth dance. When the platform has no credentials configured, a demo
 * connection is created instead so the product stays explorable.
 */
import { NextResponse } from "next/server";
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
    // Nothing to redirect to: either the platform takes user credentials (the Connections
    // page renders that form inline) or it has no OAuth configured and only demo mode is
    // available, which is a POST because it changes account state.
    const target = provider.credentialConnect ? `form=${provider.id}` : `error=${provider.id}-not-configured`;
    return NextResponse.redirect(`${appBaseUrl()}/connect?${target}`);
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
