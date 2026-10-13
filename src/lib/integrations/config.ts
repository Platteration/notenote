/**
 * What the environment turns on: sign in with Google, and the shop.
 *
 * Both are off until the operator supplies what they need, and a feature is on only when
 * everything it needs is present and well formed. With nothing set the app is exactly what it
 * was: `/api/config` says nothing is configured and no page draws a Google or Buy control. A
 * partial configuration produces one warning naming what is missing or malformed (never a
 * value), which `src/instrumentation.ts` prints at start.
 *
 * The variable names follow the shared kit's (`server/kit/README.md`) where this app has no
 * name of its own. Where it has, its own wins: the public base URL is `APP_BASE_URL`, which the
 * platform connections already build their redirect URIs from, and Google sign-in has its own
 * client pair, `GOOGLE_SIGNIN_CLIENT_ID`/`GOOGLE_SIGNIN_CLIENT_SECRET`, because
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are YouTube's: a deployment that connects YouTube
 * must not find a Sign in with Google button appear, pointing at a redirect URI nobody has
 * registered. Both pairs may name the same Google client.
 *
 * The shop does not need Google sign-in here. In the kit's apps an account *is* a Google
 * account; in this one every account, made with a password or with Google, can buy.
 */
import catalogue from "../../../server/catalogue";
import { keyMode } from "../../../server/kit/stripe.js";

type Env = Record<string, string | undefined>;

export type StripeMode = "live" | "test";

export interface SignInConfig {
  /** The site's origin, from APP_BASE_URL: every address this writes starts with it. */
  origin: string;
  clientId: string;
  clientSecret: string;
  /** SESSION_SECRET, which signs the ten-minute sign-in cookie. */
  secret: string;
  /** `<origin>/api/auth/google/callback`: register exactly this with the Google client. */
  redirectUri: string;
}

export interface ShopConfig {
  origin: string;
  key: string;
  mode: StripeMode;
  webhookSecret: string;
  /** Product id → Stripe Price id, for the products that have one. */
  prices: Map<string, string>;
}

export interface IntegrationConfig {
  signIn: SignInConfig | null;
  shop: ShopConfig | null;
  /**
   * The Stripe mode whose purchases are read and written: the key's, or live when no
   * well-formed key is set. A test-mode purchase is never read under a live key.
   */
  records: StripeMode;
  /** One line naming what is missing or malformed, never a value; null when nothing is half set. */
  warning: string | null;
}

/** The environment variable that holds a product's Stripe Price id, as the kit names it. */
export function priceVariable(productId: string): string {
  return `STRIPE_PRICE_${productId.toUpperCase().replaceAll("-", "_")}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * APP_BASE_URL's origin when it can be the base of a sign-in or a checkout: https, or http on
 * the machine itself (browsers keep Secure cookies there, and Google accepts no other plain-http
 * redirect URI), with no path, query, fragment or credentials. The app runs at the root of its
 * origin; a base with a path would name redirect URIs nothing answers.
 */
export function signInOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.origin;
  return null;
}

const GOOGLE_CLIENT_ID = /^[0-9A-Za-z_.-]{1,200}\.apps\.googleusercontent\.com$/;
const GOOGLE_CLIENT_SECRET = /^[\x21-\x7e]{10,200}$/;
const WEBHOOK_SECRET = /^whsec_[0-9A-Za-z+/=_-]{10,200}$/;
const PRICE = /^price_[0-9A-Za-z_]{1,200}$/;

export function readIntegrationConfig(env: Env): IntegrationConfig {
  const raw = (name: string): string | undefined => {
    const value = env[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const missing: string[] = [];
  const malformed: string[] = [];
  const read = <T>(name: string, parse: (value: string) => T | null): T | null => {
    const value = raw(name);
    if (value === undefined) {
      missing.push(name);
      return null;
    }
    const parsed = parse(value);
    if (parsed === null) malformed.push(name);
    return parsed;
  };
  const problems = () => [...missing.map((n) => `missing ${n}`), ...malformed.map((n) => `malformed ${n}`)];

  const signInVariables = ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"];
  const origin = read("APP_BASE_URL", signInOrigin);
  // At least what instrumentation.ts demands of it in production; the development fallback
  // key in crypto.ts is public, and must not sign anything a sign-in trusts.
  const secret = read("SESSION_SECRET", (value) => (value.length >= 16 ? value : null));
  const clientId = read("GOOGLE_SIGNIN_CLIENT_ID", (value) => (GOOGLE_CLIENT_ID.test(value) ? value : null));
  const clientSecret = read("GOOGLE_SIGNIN_CLIENT_SECRET", (value) => (GOOGLE_CLIENT_SECRET.test(value) ? value : null));
  const signInProblems = problems();
  const signIn: SignInConfig | null =
    origin && secret && clientId && clientSecret
      ? { origin, clientId, clientSecret, secret, redirectUri: `${origin}/api/auth/google/callback` }
      : null;
  const signInTouched = signInVariables.some((name) => raw(name) !== undefined);

  missing.length = 0;
  malformed.length = 0;
  const shopOrigin = read("APP_BASE_URL", signInOrigin);
  const key = read("STRIPE_SECRET_KEY", (value) => (keyMode(value) ? value : null));
  const webhookSecret = read("STRIPE_WEBHOOK_SECRET", (value) => (WEBHOOK_SECRET.test(value) ? value : null));
  // The catalogue sells one product, so its price is needed like the key: a product without
  // one is not sold, and with none sold there is no shop.
  const prices = new Map<string, string>();
  for (const product of catalogue.products) {
    const price = read(priceVariable(product.id), (value) => (PRICE.test(value) ? value : null));
    if (price) prices.set(product.id, price);
  }
  const mode = key ? keyMode(key) : null;
  const shop: ShopConfig | null =
    shopOrigin && key && mode && webhookSecret && prices.size > 0 ? { origin: shopOrigin, key, mode, webhookSecret, prices } : null;
  const shopTouched =
    ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].some((name) => raw(name) !== undefined) ||
    catalogue.products.some((product) => raw(priceVariable(product.id)) !== undefined);

  const notes: string[] = [];
  if (signInTouched && !signIn) notes.push(`sign in with Google is off (${signInProblems.join(", ")})`);
  if (shopTouched && !shop) notes.push(`the shop is off (${problems().join(", ")})`);
  return {
    signIn,
    shop,
    records: mode ?? "live",
    warning: notes.length ? `The Daily Scroll: ${notes.join("; ")}.` : null,
  };
}
