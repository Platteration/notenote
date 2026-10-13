/**
 * Sign in with Google: the start of the OpenID Connect code flow and its callback, using the
 * shared kit's `google.js` (authorize URL, PKCE, code exchange, ID-token verification against
 * Google's keys), `crypto.js` and `http.js` (the cookie). What happens to the account once
 * Google has said who this is — sign in, a new account, or a link — is the app's own
 * (`src/lib/google-accounts.ts`), and so are the sessions: a Google sign-in ends in the same
 * `ds_session` cookie a password does.
 *
 * Between the start and the callback, the state, nonce, PKCE verifier, where to go afterwards
 * and what the flow is for travel in one cookie, `__Host-notenote-oauth` (HttpOnly, Secure,
 * SameSite=Lax, ten minutes), signed with SESSION_SECRET and bound to its own expiry. Nothing is
 * written to the database for a sign-in that has not finished, so an anonymous visitor
 * starting sign-ins writes nothing at all. The cookie binds the callback to the browser that
 * started the flow: a callback carrying someone else's code and state fails the state check,
 * which is what stops a login CSRF.
 */
import { AuthError, authorizeUrl, exchangeCode, pkcePair, verifyIdToken, type Fetch, type KeySource } from "../../../server/kit/google.js";
import { base64url, fromBase64url, fromUtf8, hmacSha256, hmacVerify, randomId, safeEqual, utf8 } from "../../../server/kit/crypto.js";
import { clearCookie, parseCookies, serializeCookie } from "../../../server/kit/http.js";
import type { SignInConfig } from "./config";

export const OAUTH_COOKIE = "__Host-notenote-oauth";
const FLOW_SECONDS = 600;
/** A return path is a path on this site, and a browser drops a cookie past 4 KB. */
const MAX_RETURN = 1024;

/** What a flow is for: signing in (or up), or linking Google to the signed-in account. */
export type Intent = "signin" | "link";

export interface Flow {
  /** The intent. */
  i: Intent;
  /** For a link, the account it was started from; the callback must still be signed in to it. */
  u: string | null;
  s: string;
  n: string;
  v: string;
  /** Where to send the browser afterwards, already checked by `returnPath`. */
  r: string | null;
  /** The browser's timezone, for an account the sign-in makes. */
  z: string | null;
  /** Expiry, milliseconds since the epoch. */
  e: number;
}

export interface Identity {
  /** Google's subject identifier: who this is, for good. */
  sub: string;
  /** Present only when Google says it is verified. */
  email?: string;
}

export type Log = (level: "warn" | "error", message: string) => void;

export interface GoogleSignIn {
  readonly origin: string;
  start(options: { intent: Intent; userId: string | null; returnTo: string | null; timezone: string | null }): Promise<{ location: string; cookie: string }>;
  /** The callback: who Google says this is, or why not. Never throws. */
  finish(request: Request): Promise<{ ok: true; flow: Flow; identity: Identity } | { ok: false; intent: Intent | null }>;
  /** The Set-Cookie value that clears the flow cookie, sent with every callback's answer. */
  readonly clearCookie: string;
}

/**
 * Where to send the browser after a sign-in: a path under this site, or nothing (the caller's
 * default). It must start with exactly one `/`, hold no backslash and no control character as
 * given and once percent-decoded, resolve to this origin, not resolve to a path starting `//`
 * (`/.//evil.example` resolves to `//evil.example`, which a client-side router would take for
 * another host), not lie under `/api/`, and fit in the cookie. The callback writes the origin in
 * front of what this returns, so the redirect is to this site whatever it holds.
 */
export function returnPath(value: unknown): string | null {
  if (typeof value !== "string" || !plainPath(value)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!plainPath(decoded)) return null;
  const origin = "https://daily-scroll.invalid";
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.startsWith("//") || url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.length > MAX_RETURN ? null : path;
}

function plainPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * A timezone name as the browser reports it, in the characters such names use and at most 64 of
 * them, since it rides in the cookie; whether it is a real zone is saveSettings' to say.
 */
export function timezoneParam(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) ? value : null;
}

const SEAL_LABEL = "notenote.google-oauth.";

async function seal(flow: Flow, secret: string): Promise<string> {
  const payload = base64url(utf8(JSON.stringify(flow)));
  return `${payload}.${base64url(await hmacSha256(secret, `${SEAL_LABEL}${payload}`))}`;
}

/**
 * The flow a cookie carries, when its MAC is ours and it has not expired. Only this server can
 * seal a flow, so a cookie that passes the MAC holds exactly what `start` sealed (its return path
 * already checked by `returnPath`); the expiry is the one thing left to ask of it.
 */
async function open(value: string, secret: string, now: number): Promise<Flow | null> {
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const mac = fromBase64url(value.slice(dot + 1));
  if (!mac || !(await hmacVerify(secret, `${SEAL_LABEL}${payload}`, mac))) return null;
  // Sealed by this server: base64url of the JSON of a Flow.
  const flow = JSON.parse(fromUtf8(fromBase64url(payload)!)!) as Flow;
  return flow.e > now ? flow : null;
}

export function createGoogleSignIn(options: { config: SignInConfig; fetch: Fetch; keys: KeySource; now: () => number; log: Log; timeoutMs: number }): GoogleSignIn {
  const { config, fetch, keys, now, log, timeoutMs } = options;
  return {
    origin: config.origin,
    clearCookie: clearCookie(OAUTH_COOKIE),

    async start({ intent, userId, returnTo, timezone }) {
      const state = randomId();
      const nonce = randomId();
      const { verifier, challenge } = await pkcePair();
      const flow: Flow = { i: intent, u: intent === "link" ? userId : null, s: state, n: nonce, v: verifier, r: returnTo, z: timezone, e: now() + FLOW_SECONDS * 1000 };
      return {
        location: authorizeUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state, nonce, challenge }),
        cookie: serializeCookie(OAUTH_COOKIE, await seal(flow, config.secret), FLOW_SECONDS),
      };
    },

    async finish(request) {
      let intent: Intent | null = null;
      // Every failure is logged with the app's own word for it, never anything Google sent.
      const failed = (reason: string | null) => {
        if (reason) log("warn", `Sign in with Google failed (${reason})`);
        return { ok: false as const, intent };
      };
      try {
        const sealed = parseCookies(request.headers.get("cookie")).get(OAUTH_COOKIE);
        const flow = sealed ? await open(sealed, config.secret, now()) : null;
        if (!flow) return failed("no valid sign-in cookie");
        intent = flow.i;
        const params = new URL(request.url).searchParams;
        // The visitor said no at Google, or Google could not ask: nothing to log.
        if (params.has("error")) return failed(null);
        const state = params.get("state");
        if (state === null || !(await safeEqual(state, flow.s))) return failed("state");
        const code = params.get("code");
        if (!code || code.length > 4096) return failed("code");
        const idToken = await exchangeCode({ fetch, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, code, verifier: flow.v, timeoutMs });
        const identity = await verifyIdToken(idToken, { clientId: config.clientId, nonce: flow.n, now: now(), keys });
        return { ok: true, flow, identity };
      } catch (error) {
        return failed(error instanceof AuthError ? error.reason : error instanceof Error ? error.name : typeof error);
      }
    },
  };
}
