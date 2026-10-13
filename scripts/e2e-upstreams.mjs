/**
 * A fake Google and a fake Stripe for the end-to-end walk's server, loaded into that server's
 * process ahead of Next (`node --import ./scripts/e2e-upstreams.mjs .../next start`, which
 * scripts/e2e.sh does for the second server it starts, and only for it).
 *
 * It replaces the global fetch, which is the way out to Google and Stripe that the app's routes
 * are given (`integrations()` in src/lib/integrations/index.ts), with one that answers Google's
 * token and key addresses and Stripe's API itself and hands every other address to the real
 * fetch. The app reads no variable that points it at another Google or Stripe: the addresses
 * are the shared kit's constants, and this answers them inside the process, as a unit test's
 * fake does through `createIntegrations({ fetch })`.
 *
 * Faithful where it matters. The token endpoint checks the client, the redirect URI and the PKCE
 * verifier against the challenge the consent carried, takes a code once, and issues an RS256 ID
 * token signed with a key made here by Web Crypto and published as the JWKS. Stripe checks the
 * secret key, prices the one product, and records each Checkout Session it creates in the
 * address it answers, so the walk can post the webhook Stripe would.
 */
import { createHash } from "node:crypto";
import { ENV, PRICE, readConsentCode } from "./e2e-fakes.mjs";

const KID = "e2e-walk-key";
const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
const spent = new Set();
let sessions = 0;

const b64url = (data) => Buffer.from(data).toString("base64url");

async function idToken(claims) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

/** Said on the server's log, so a walk that fails because of what the app sent says why. */
function refuse(what, status = 400) {
  console.error(`e2e fake upstream refused: ${what}`);
  return Response.json({ error: "refused_by_fake" }, { status });
}

async function google(url, init) {
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }, { headers: { "Cache-Control": "public, max-age=3600" } });
  }
  if (url !== "https://oauth2.googleapis.com/token" || init?.method !== "POST") return null;
  const form = new URLSearchParams(String(init.body ?? ""));
  const code = form.get("code") ?? "";
  const consent = readConsentCode(code);
  if (!consent || spent.has(code)) return refuse("an unknown or spent code");
  spent.add(code);
  if (form.get("client_id") !== ENV.GOOGLE_SIGNIN_CLIENT_ID || form.get("client_secret") !== ENV.GOOGLE_SIGNIN_CLIENT_SECRET) return refuse("the client");
  if (form.get("grant_type") !== "authorization_code" || !/\/api\/auth\/google\/callback$/.test(form.get("redirect_uri") ?? "")) return refuse("the grant or redirect URI");
  if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== consent.challenge) return refuse("the PKCE verifier");
  const at = Math.floor(Date.now() / 1000);
  return Response.json({
    access_token: "ya29.e2e",
    token_type: "Bearer",
    expires_in: 3599,
    id_token: await idToken({
      iss: "https://accounts.google.com",
      aud: ENV.GOOGLE_SIGNIN_CLIENT_ID,
      azp: ENV.GOOGLE_SIGNIN_CLIENT_ID,
      sub: consent.sub,
      iat: at,
      exp: at + 3600,
      nonce: consent.nonce,
      ...(consent.email ? { email: consent.email, email_verified: consent.emailVerified } : {}),
    }),
  });
}

async function stripe(url, init) {
  if (!url.startsWith("https://api.stripe.com/v1/")) return null;
  const headers = new Headers(init?.headers);
  if (headers.get("authorization") !== `Bearer ${ENV.STRIPE_SECRET_KEY}`) return refuse("the Stripe key", 401);
  const path = url.slice("https://api.stripe.com/v1".length);
  if ((init?.method ?? "GET") === "GET" && path === `/prices/${ENV.STRIPE_PRICE_SUPPORTER}`) {
    return Response.json({ id: ENV.STRIPE_PRICE_SUPPORTER, object: "price", active: true, type: "one_time", recurring: null, ...PRICE });
  }
  if (init?.method === "POST" && path === "/checkout/sessions") {
    const params = new URLSearchParams(String(init.body ?? ""));
    if (params.get("line_items[0][price]") !== ENV.STRIPE_PRICE_SUPPORTER || params.get("mode") !== "payment" || !headers.get("idempotency-key")) {
      return refuse("the Checkout Session");
    }
    const id = `cs_test_e2e${++sessions}`;
    // What Stripe would carry back in its webhook, written into the address the browser is sent
    // to, which the walk reads where it stands in for Stripe's page.
    const session = {
      id,
      client_reference_id: params.get("client_reference_id"),
      metadata: { app: params.get("metadata[app]"), user: params.get("metadata[user]"), product: params.get("metadata[product]") },
      customer: params.get("customer"),
      success_url: params.get("success_url"),
      cancel_url: params.get("cancel_url"),
    };
    return Response.json({ id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}?e2e=${b64url(JSON.stringify(session))}` });
  }
  return refuse(`${init?.method ?? "GET"} ${path}`, 404);
}

const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  return (await google(url, init)) ?? (await stripe(url, init)) ?? real(input, init);
};
