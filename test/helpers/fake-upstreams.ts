/**
 * A fake Google and a fake Stripe, answering the addresses the shared kit calls, for tests to
 * hand to `createIntegrations({ fetch })` (or to stand in for the global fetch the routes use).
 *
 * Faithful where it matters: Google's ID tokens are RS256 JWTs signed with a key made here by
 * Web Crypto and published as a JWKS; the token endpoint checks the client, the redirect URI and
 * the PKCE verifier against the challenge the authorize URL carried, and a code works once.
 * Stripe's webhooks are signed here with node:crypto, independently of the kit's own HMAC.
 */
import { createHash, createHmac } from "node:crypto";

export const CLIENT_ID = "test-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "test-google-client-secret";
export const STRIPE_KEY = "sk_test_0123456789abcdefghij";
export const WEBHOOK_SECRET = "whsec_test0123456789abcdefghij";
export const PRICE_ID = "price_testSupporter";

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

type FetchInput = string | URL | Request;

export interface Consent {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  /** Claims to change in the ID token Google then issues, to stage a bad one. */
  claims?: Record<string, unknown>;
}

export interface FakeGoogle {
  /** The visitor consents at `authorizeUrl`: the code and state Google sends back to the callback. */
  consent(authorizeUrl: string, who: Consent): { code: string; state: string; redirectUri: string };
  /** A JWT signed with the published key (or another), for staging a token by hand. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** What was asked of Google, by address. */
  calls: string[];
  fetch(input: FetchInput, init?: RequestInit): Promise<Response> | null;
}

export async function createFakeGoogle(options: { now: () => number; clientId?: string; clientSecret?: string; kid?: string }): Promise<FakeGoogle> {
  const clientId = options.clientId ?? CLIENT_ID;
  const clientSecret = options.clientSecret ?? CLIENT_SECRET;
  const kid = options.kid ?? "fake-key-1";
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; who: Consent }>();
  const calls: string[] = [];
  let issued = 0;

  async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid, typ: "JWT" }): Promise<string> {
    const head = b64url(JSON.stringify(header));
    const body = b64url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(Buffer.from(signature))}`;
  }

  return {
    calls,
    sign,
    consent(authorizeUrl, who) {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error(`not Google's authorize URL: ${authorizeUrl}`);
      const p = url.searchParams;
      if (p.get("response_type") !== "code" || p.get("client_id") !== clientId || p.get("scope") !== "openid email" || p.get("code_challenge_method") !== "S256") {
        throw new Error(`a malformed authorize request: ${authorizeUrl}`);
      }
      const code = `code-${++issued}`;
      codes.set(code, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")!, who });
      return { code, state: p.get("state")!, redirectUri: p.get("redirect_uri")! };
    },
    fetch(input, init) {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
        calls.push("jwks");
        return Promise.resolve(
          Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, { headers: { "Cache-Control": "public, max-age=3600" } }),
        );
      }
      if (url === "https://oauth2.googleapis.com/token") {
        calls.push("token");
        return (async () => {
          const form = new URLSearchParams(String(init?.body ?? ""));
          const entry = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (
            !entry ||
            form.get("client_id") !== clientId ||
            form.get("client_secret") !== clientSecret ||
            form.get("grant_type") !== "authorization_code" ||
            form.get("redirect_uri") !== entry.redirectUri ||
            createHash("sha256").update(verifier).digest("base64url") !== entry.challenge
          ) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          const at = Math.floor(options.now() / 1000);
          const { who } = entry;
          const claims: Record<string, unknown> = {
            iss: "https://accounts.google.com",
            aud: clientId,
            azp: clientId,
            sub: who.sub,
            iat: at,
            exp: at + 3600,
            nonce: entry.nonce,
            ...(who.email !== undefined ? { email: who.email, email_verified: who.emailVerified ?? true } : {}),
            ...who.claims,
          };
          return Response.json({ access_token: "ya29.fake", token_type: "Bearer", expires_in: 3599, id_token: await sign(claims) });
        })();
      }
      return null;
    },
  };
}

export interface CreatedSession {
  id: string;
  params: URLSearchParams;
  idempotencyKey: string | null;
}

export interface FakeStripe {
  prices: Map<string, Record<string, unknown>>;
  sessions: CreatedSession[];
  calls: string[];
  /** Answer the next calls with this status instead (502 to stage an outage). */
  failWith: number | null;
  fetch(input: FetchInput, init?: RequestInit): Promise<Response> | null;
}

export function createFakeStripe(options: { key?: string } = {}): FakeStripe {
  const key = options.key ?? STRIPE_KEY;
  const stripe: FakeStripe = {
    prices: new Map([[PRICE_ID, { id: PRICE_ID, object: "price", active: true, currency: "eur", unit_amount: 300, recurring: null, type: "one_time" }]]),
    sessions: [],
    calls: [],
    failWith: null,
    fetch(input, init) {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.stripe.com/v1/")) return null;
      const path = url.slice("https://api.stripe.com/v1".length);
      stripe.calls.push(`${init?.method ?? "GET"} ${path}`);
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== `Bearer ${key}`) return Promise.resolve(Response.json({ error: { type: "invalid_request_error" } }, { status: 401 }));
      if (stripe.failWith !== null) return Promise.resolve(Response.json({ error: { type: "api_error" } }, { status: stripe.failWith }));
      if ((init?.method ?? "GET") === "GET" && path.startsWith("/prices/")) {
        const price = stripe.prices.get(decodeURIComponent(path.slice("/prices/".length)));
        return Promise.resolve(price ? Response.json(price) : Response.json({ error: { type: "invalid_request_error" } }, { status: 404 }));
      }
      if (init?.method === "POST" && path === "/checkout/sessions") {
        const params = new URLSearchParams(String(init.body ?? ""));
        const id = `cs_test_${stripe.sessions.length + 1}abc`;
        stripe.sessions.push({ id, params, idempotencyKey: headers.get("idempotency-key") });
        return Promise.resolve(Response.json({ id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}` }));
      }
      return Promise.resolve(Response.json({ error: { type: "invalid_request_error" } }, { status: 404 }));
    },
  };
  return stripe;
}

/** One fetch that answers as Google and Stripe, and refuses anything else. */
export function upstreams(google: FakeGoogle | null, stripe: FakeStripe | null): (input: FetchInput, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const answer = google?.fetch(input, init) ?? stripe?.fetch(input, init);
    if (answer) return answer;
    return Promise.reject(new Error(`a test reached for the network: ${String(input)}`));
  };
}

/** A Stripe event, as Stripe sends it. */
export function stripeEvent(type: string, object: Record<string, unknown>, options: { id?: string; livemode?: boolean; created?: number } = {}): string {
  return JSON.stringify({
    id: options.id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    object: "event",
    type,
    livemode: options.livemode ?? false,
    created: options.created ?? Math.floor(Date.now() / 1000),
    data: { object },
  });
}

/** `Stripe-Signature` for a body, signed with node:crypto, not with the kit's own HMAC. */
export function stripeSignature(body: string, options: { secret?: string; t?: number; extra?: string[] } = {}): string {
  const t = options.t ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", options.secret ?? WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return [`t=${t}`, ...(options.extra ?? []), `v1=${v1}`].join(",");
}
