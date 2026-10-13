/**
 * The shop: one "Support this app" product, sold through Stripe Checkout and granted by Stripe's
 * signed webhook alone, using the shared kit's `stripe.js` (price lookup, Checkout Session,
 * signature check, event parsing). The page never loads Stripe.js: it is sent to the Checkout
 * address this returns, and nothing the page says grants anything.
 *
 * What an account holds is read from `purchases`, which only the webhook writes, one row per
 * payment. Each event is applied once: `stripe_events` remembers the ids already applied, in the
 * same transaction as what they did, so a retried or replayed delivery is answered 200 and
 * changes nothing. A database failure is a 500, which Stripe retries.
 */
import catalogue from "../../../server/catalogue";
import { randomId } from "../../../server/kit/crypto.js";
import { HttpError, isRecord, readBytes } from "../../../server/kit/http.js";
import { StripeError, createCheckoutSession, getPrice, parseEvent, verifySignature, type Fetch, type PriceInfo, type StripeEvent } from "../../../server/kit/stripe.js";
import { MAX_REQUEST_BYTES } from "../api";
import { getDb, transaction } from "../db";
import { rateLimit } from "../rate-limit";
import type { ShopConfig, StripeMode } from "./config";
import type { Log } from "./google";

type Product = (typeof catalogue.products)[number];

/** A notenote account id, as `crypto.randomUUID()` writes it. */
const USER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOMER = /^cus_[0-9A-Za-z_]{1,250}$/;
const PAYMENT_INTENT = /^pi_[0-9A-Za-z_]{1,250}$/;
const CHECKOUT_SESSION = /^cs_[0-9A-Za-z_]{1,250}$/;

const HOUR_MS = 3_600_000;
const PRICE_RETRY_MS = 60_000;
const CHECKOUTS_PER_HOUR = 10;
/** How long a Checkout Session stays payable: Stripe's floor is 30 minutes, its default a day. */
const CHECKOUT_SECONDS = 3_600;
/** How long an applied event is remembered: Stripe retries a delivery for up to three days. */
const EVENT_TTL_MS = 30 * 86_400_000;
/** How long a refund that arrived before its purchase is remembered. */
const TOMBSTONE_TTL_MS = 90 * 86_400_000;

export interface ListedProduct {
  id: string;
  name: string;
  description: string;
  mode: "payment" | "subscription";
  price?: PriceInfo;
}

/** An answer for a route to send: a status and a JSON body, and any headers it needs. */
export interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface Shop {
  readonly mode: StripeMode;
  /** The products on sale, each with its price when Stripe told us one. */
  listed(): Promise<ListedProduct[]>;
  checkout(userId: string, productId: unknown): Promise<Answer>;
  webhook(request: Request): Promise<Answer>;
}

/** The entitlements an account holds: its purchases in this Stripe mode that were not reversed. */
export function entitlementsOf(userId: string, mode: StripeMode): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT grants FROM purchases WHERE user_id = ? AND mode = ? AND revoked = 0 AND grants IS NOT NULL ORDER BY grants")
    .all(userId, mode) as Array<{ grants: string }>;
  return rows.map((r) => r.grants);
}

function productById(id: unknown): Product | undefined {
  return typeof id === "string" ? catalogue.products.find((p) => p.id === id) : undefined;
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/** A charge refunded in full: Stripe says so, or the refunds add up to the amount. */
function fullyRefunded(charge: Record<string, unknown>): boolean {
  if (charge.refunded === true) return true;
  const { amount, amount_refunded: refunded } = charge;
  return typeof amount === "number" && typeof refunded === "number" && amount > 0 && refunded >= amount;
}

export function createShop(options: { config: ShopConfig; fetch: Fetch; now: () => number; log: Log; timeoutMs: number }): Shop {
  const { config, fetch, now, log, timeoutMs } = options;
  const mode = config.mode;
  const priceCache = new Map<string, { value: PriceInfo | null; known: boolean; until: number }>();
  const pending = new Map<string, Promise<{ value: PriceInfo | null; known: boolean }>>();

  /**
   * A product's price from Stripe, kept for an hour (a lookup that failed, for a minute).
   * `known` says whether Stripe answered: a price it answered with that cannot be sold (no fixed
   * amount, inactive, recurring for a one-time product) means the product is not sold, while a
   * lookup that failed lists it without a price and leaves the judgement to Checkout.
   */
  function priceOf(product: Product): Promise<{ value: PriceInfo | null; known: boolean }> {
    const price = config.prices.get(product.id);
    if (!price) return Promise.resolve({ value: null, known: false });
    const cached = priceCache.get(product.id);
    if (cached && cached.until > now()) return Promise.resolve(cached);
    let lookup = pending.get(product.id);
    if (!lookup) {
      lookup = (async () => {
        try {
          const value = await getPrice({ fetch, key: config.key, price, mode: product.mode, timeoutMs });
          if (!value) log("warn", `The Daily Scroll: ${product.id} is not sold: its Stripe price is inactive, has no fixed amount, or is recurring`);
          priceCache.set(product.id, { value, known: true, until: now() + HOUR_MS });
          return { value, known: true };
        } catch (error) {
          const status = error instanceof StripeError ? `Stripe ${error.status}` : error instanceof Error ? error.name : typeof error;
          log("warn", `The Daily Scroll: the price lookup for ${product.id} failed (${status})`);
          priceCache.set(product.id, { value: null, known: false, until: now() + PRICE_RETRY_MS });
          return { value: null, known: false };
        } finally {
          pending.delete(product.id);
        }
      })();
      pending.set(product.id, lookup);
    }
    return lookup;
  }

  // -- the webhook's writes, each idempotent

  /** A paid checkout: record the purchase for the account its metadata names. */
  function onCheckoutPaid(session: Record<string, unknown>, at: number): void {
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return;
    const meta = isRecord(session.metadata) ? session.metadata : {};
    if (meta.app !== catalogue.app) return;
    const user = matching(meta.user, USER);
    const product = productById(meta.product);
    if (!user || !product) return;
    if (session.client_reference_id !== undefined && session.client_reference_id !== null && session.client_reference_id !== user) return;
    if (session.mode !== product.mode) return;
    const ref = matching(session.payment_intent, PAYMENT_INTENT) ?? matching(session.id, CHECKOUT_SESSION);
    if (!ref) return;
    const customer = matching(session.customer, CUSTOMER);
    const db = getDb();
    const held = db.prepare("SELECT user_id FROM purchases WHERE mode = ? AND ref = ?").get(mode, ref) as { user_id: string | null } | undefined;
    // A purchase recorded for someone else stays theirs.
    if (held && held.user_id !== null && held.user_id !== user) return;
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(user)) {
      // Paid for by an account deleted before Stripe's webhook arrived: there is no one to
      // grant it to. The owner can refund it from the Stripe dashboard.
      log("warn", `The Daily Scroll: payment ${ref} is for an account that no longer exists; refund it in the Stripe dashboard`);
      return;
    }
    // A refund or dispute that arrived first left the row revoked, and it stays revoked.
    db.prepare(
      `INSERT INTO purchases (mode, ref, user_id, product, grants, customer, revoked, recorded_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (mode, ref) DO UPDATE SET user_id = excluded.user_id, product = excluded.product, grants = excluded.grants,
         customer = COALESCE(excluded.customer, purchases.customer)`,
    ).run(mode, ref, user, product.id, product.grants, customer, at);
  }

  /** A refund in full, or a dispute: what that payment granted is taken back. */
  function onPaymentReversed(paymentIntent: unknown, at: number): void {
    const ref = matching(paymentIntent, PAYMENT_INTENT);
    if (!ref) return;
    const db = getDb();
    const revoked = db.prepare("UPDATE purchases SET revoked = 1 WHERE mode = ? AND ref = ?").run(mode, ref);
    // Not seen yet (or another app's): remember it, so a completion arriving later grants nothing.
    if (Number(revoked.changes) === 0) {
      db.prepare("INSERT INTO purchases (mode, ref, user_id, revoked, recorded_at) VALUES (?, ?, NULL, 1, ?)").run(mode, ref, at);
    }
  }

  /** Whether the event is one this shop acts on, having acted on it. */
  function apply(event: StripeEvent, at: number): boolean {
    const object = event.object;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        onCheckoutPaid(object, at);
        return true;
      case "checkout.session.async_payment_failed":
        return true;
      case "charge.refunded":
        if (fullyRefunded(object)) onPaymentReversed(object.payment_intent, at);
        return true;
      case "charge.dispute.created":
        onPaymentReversed(object.payment_intent, at);
        return true;
      default:
        // Subscription events among them: nothing here is a subscription.
        return false;
    }
  }

  return {
    mode,

    async listed() {
      const sold = catalogue.products.filter((p) => config.prices.has(p.id));
      const found = await Promise.all(sold.map(priceOf));
      const out: ListedProduct[] = [];
      sold.forEach((product, index) => {
        const price = found[index];
        if (price?.known && !price.value) return;
        out.push({ id: product.id, name: product.name, description: product.description, mode: product.mode, ...(price?.value ? { price: price.value } : {}) });
      });
      return out;
    },

    async checkout(userId, productId) {
      const product = productById(productId);
      const price = product ? config.prices.get(product.id) : undefined;
      if (!product || !price) return { status: 404, body: { error: "That is not for sale here" } };
      const priced = await priceOf(product);
      if (priced.known && !priced.value) return { status: 404, body: { error: "That is not for sale here" } };
      if (entitlementsOf(userId, mode).includes(product.grants)) return { status: 409, body: { error: "You already have this" } };
      const limited = rateLimit(`checkout:${userId}`, CHECKOUTS_PER_HOUR, HOUR_MS, now());
      if (!limited.ok) {
        return { status: 429, body: { error: "Too many checkouts started. Try again later." }, headers: { "Retry-After": String(limited.retryAfter) } };
      }
      // The Stripe customer of an earlier purchase, so a second one lands beside it.
      const known = getDb()
        .prepare("SELECT customer FROM purchases WHERE user_id = ? AND mode = ? AND customer IS NOT NULL ORDER BY recorded_at DESC LIMIT 1")
        .get(userId, mode) as { customer: string } | undefined;
      try {
        const created = await createCheckoutSession({
          fetch,
          key: config.key,
          app: catalogue.app,
          mode: product.mode,
          price,
          user: userId,
          product: product.id,
          ...(known ? { customer: known.customer } : {}),
          successUrl: `${config.origin}/settings?purchase=success`,
          cancelUrl: `${config.origin}/settings?purchase=cancelled`,
          expiresAt: Math.floor(now() / 1000) + CHECKOUT_SECONDS,
          idempotencyKey: `notenote-checkout-${randomId(24)}`,
          timeoutMs,
        });
        return { status: 200, body: { url: created.url } };
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        log("error", `The Daily Scroll: checkout failed (Stripe ${error.status})`);
        return { status: 502, body: { error: "Stripe could not be reached. Try again in a moment." } };
      }
    },

    async webhook(request) {
      let payload: Uint8Array;
      try {
        // The raw bytes, before anything parses them: the signature is over exactly these.
        payload = await readBytes(request, MAX_REQUEST_BYTES);
      } catch (error) {
        if (error instanceof HttpError) return { status: error.status, body: { error: error.code } };
        throw error;
      }
      const at = now();
      const signed = await verifySignature({ secret: config.webhookSecret, header: request.headers.get("stripe-signature"), payload, now: at });
      if (!signed) return { status: 400, body: { error: "bad_request" } };
      const event = parseEvent(payload);
      if (!event || event.livemode !== (mode === "live")) return { status: 400, body: { error: "bad_request" } };
      const db = getDb();
      try {
        transaction(() => {
          if (db.prepare("SELECT 1 FROM stripe_events WHERE id = ?").get(event.id)) return;
          if (apply(event, at)) {
            db.prepare("INSERT INTO stripe_events (id, mode, type, processed_at) VALUES (?, ?, ?, ?)").run(event.id, mode, event.type, at);
          }
          // Housekeeping, while the write lock is held anyway.
          db.prepare("DELETE FROM stripe_events WHERE processed_at < ?").run(at - EVENT_TTL_MS);
          db.prepare("DELETE FROM purchases WHERE user_id IS NULL AND recorded_at < ?").run(at - TOMBSTONE_TTL_MS);
        });
      } catch (error) {
        log("error", `The Daily Scroll: a Stripe event could not be recorded (${error instanceof Error ? error.name : typeof error}); Stripe will retry it`);
        return { status: 500, body: { error: "internal" } };
      }
      return { status: 200, body: { received: true } };
    },
  };
}
