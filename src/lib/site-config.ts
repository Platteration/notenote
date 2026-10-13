/**
 * What a page knows about sign in with Google and the shop, and the words it says about them.
 *
 * Import-free, so client components can use it and a test can load it bare. The page asks
 * `GET /api/config` once (`useSiteConfig` in `src/lib/site-config-client.ts`) and reads the answer
 * here, field by field: a 404, a network error, a body that is not JSON, or nothing turned on
 * means the feature does not exist, and nothing about it is drawn, stored or asked again. Server
 * data is shown as text (React children), never as HTML.
 */

export interface SitePrice {
  /** In the currency's smallest unit as Stripe counts it. */
  unit_amount: number;
  /** Lowercase ISO 4217. */
  currency: string;
}

export interface SiteProduct {
  id: string;
  name: string;
  description: string;
  mode: "payment" | "subscription";
  price?: SitePrice;
}

export interface SiteConfig {
  google: boolean;
  products: SiteProduct[];
}

/** Nothing configured: what a page assumes until `/api/config` says otherwise, and for good if it cannot. */
export const SITE_OFF: SiteConfig = { google: false, products: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function readPrice(value: unknown): SitePrice | undefined {
  if (!isRecord(value)) return undefined;
  const amount = value.unit_amount;
  const currency = value.currency;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return undefined;
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return undefined;
  return { unit_amount: amount, currency };
}

/** `GET /api/config`'s answer, read field by field; anything else is "nothing configured". */
export function readSiteConfig(status: number, body: string): SiteConfig {
  if (status !== 200) return SITE_OFF;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return SITE_OFF;
  }
  if (!isRecord(data)) return SITE_OFF;
  const google = isRecord(data.auth) && data.auth.google === true;
  const products: SiteProduct[] = [];
  const listed = isRecord(data.shop) && Array.isArray(data.shop.products) ? data.shop.products : [];
  for (const raw of listed.slice(0, 50)) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id, 32);
    const name = text(raw.name, 100);
    const description = text(raw.description, 500);
    const mode = raw.mode === "payment" || raw.mode === "subscription" ? raw.mode : null;
    if (!id || !name || description === null || !mode) continue;
    const price = readPrice(raw.price);
    products.push({ id, name, description, mode, ...(price ? { price } : {}) });
  }
  return { google, products };
}

/** Stripe's zero-decimal currencies: an amount of 499 JPY is ¥499. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Its three-decimal ones: 1000 BHD-thousandths is 1 BHD. */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** A Stripe price as the visitor reads it, in its own currency, through Intl.NumberFormat. */
export function formatPrice(price: SitePrice, locale?: string): string {
  const divisor = ZERO_DECIMAL.has(price.currency) ? 1 : THREE_DECIMAL.has(price.currency) ? 1000 : 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: price.currency.toUpperCase() }).format(price.unit_amount / divisor);
  } catch {
    return `${(price.unit_amount / divisor).toString()} ${price.currency.toUpperCase()}`;
  }
}

/**
 * Only Stripe's own Checkout is somewhere Buy may send the browser. The slash after the host is
 * what makes the prefix an origin: `https://checkout.stripe.com.evil.example/` does not have it.
 */
export function isCheckoutUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://checkout.stripe.com/");
}

/** Only Google's consent page is somewhere Link Google may send the browser. */
export function isGoogleConsentUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://accounts.google.com/");
}

/**
 * Where "Sign in with Google" goes: the start of the flow, with where to land afterwards (the
 * sign-in form's own `?next=`, checked again by the server) and the browser's timezone, for an
 * account the sign-in makes.
 */
export function googleStartHref(next: string | null, timezone: string | null): string {
  const params = new URLSearchParams();
  if (next) params.set("return", next);
  if (timezone) params.set("tz", timezone);
  const query = params.toString();
  return `/api/auth/google/start${query ? `?${query}` : ""}`;
}

/** The same address without one query parameter, for `history.replaceState` once it has been read. */
export function withoutParam(href: string, name: string): string {
  const url = new URL(href);
  url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The words, the same in every app that carries the kit where the charter gives them. */
export const SIGN_IN_WITH_GOOGLE = "Sign in with Google";
export const BUY = "Buy";
export const OWNED = "Owned";
export const thanks = (name: string) => `Thank you — ${name} is unlocked.`;
export const PAYMENT_PENDING = "Payment received. It can take a minute to appear — reload to check.";

const SIGN_IN_NOTICES: Record<string, string> = {
  failed: "Sign-in didn't complete.",
  exists:
    "An account here already uses that Google account's email address. Sign in with that account's password, then link Google from Settings.",
  noemail: "Google didn't share a verified email address for that account, so no account was made.",
  limited: "Too many accounts created from here. Try again later.",
};

const LINK_NOTICES: Record<string, { kind: "ok" | "err"; text: string }> = {
  done: { kind: "ok", text: "Google is linked. You can sign in with it as well as your password." },
  failed: { kind: "err", text: "Linking Google didn't complete." },
  taken: { kind: "err", text: "That Google account already signs in to another account here." },
};

/** What `?signin=<word>` says on the sign-in page; an unknown word says the sign-in failed. */
export function signInNotice(word: string | null): string | null {
  if (word === null) return null;
  return Object.prototype.hasOwnProperty.call(SIGN_IN_NOTICES, word) ? SIGN_IN_NOTICES[word]! : SIGN_IN_NOTICES.failed!;
}

/** What `?link=<word>` says in Settings; an unknown word says the link failed. */
export function linkNotice(word: string | null): { kind: "ok" | "err"; text: string } | null {
  if (word === null) return null;
  return Object.prototype.hasOwnProperty.call(LINK_NOTICES, word) ? LINK_NOTICES[word]! : LINK_NOTICES.failed!;
}

/**
 * The About card's sentences for a deployment with sign in with Google, and with the shop, on.
 * Each is shown only where its feature is: one with neither turned on talks to neither.
 */
export const GOOGLE_PRIVACY =
  "If you sign in with Google, Google tells this server your Google account's id and email address, which it keeps with your account.";
export const STRIPE_PRIVACY =
  "If you support the app, Stripe handles the payment on its own page; this server keeps what was bought and Stripe's customer id, never your card.";
