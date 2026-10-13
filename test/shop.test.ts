import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStripe, PRICE_ID, STRIPE_KEY, stripeEvent, stripeSignature, upstreams, WEBHOOK_SECRET, type FakeStripe } from "./helpers/fake-upstreams";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-shop-tests";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const BASE = "https://scroll.example";
const SHOP_ENV = {
  APP_BASE_URL: BASE,
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SUPPORTER: PRICE_ID,
};

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { createSession } = await import("@/lib/session");
const { createIntegrations, isSupporter, resetIntegrations } = await import("@/lib/integrations");
const { entitlementsOf } = await import("@/lib/integrations/shop");
const { deleteAccountData, buildExport } = await import("@/lib/account-data");
const { resetAllRateLimits } = await import("@/lib/rate-limit");
const { POST: checkout } = await import("@/app/api/checkout/route");
const { POST: webhook } = await import("@/app/api/webhooks/stripe/route");
const { GET: config } = await import("@/app/api/config/route");
const { GET: me } = await import("@/app/api/auth/me/route");

let clock = Date.UTC(2026, 9, 13, 12, 0);
let stripe: FakeStripe;
const logged: string[] = [];
let userId: string;

beforeEach(async () => {
  jar.clear();
  resetAllRateLimits();
  logged.length = 0;
  Object.assign(process.env, SHOP_ENV);
  resetIntegrations();
  stripe = createFakeStripe();
  vi.stubGlobal("fetch", upstreams(null, stripe));
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => void logged.push(`warn: ${String(m)}`));
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void logged.push(`error: ${String(m)}`));
  const db = getDb();
  for (const table of ["purchases", "stripe_events", "sessions", "settings", "users"]) db.exec(`DELETE FROM ${table}`);
  userId = (await signUp({ email: "buyer@example.com", displayName: "Buyer", password: "password123" })).id;
  await createSession(userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of Object.keys(SHOP_ENV)) delete process.env[name];
  resetIntegrations();
});

const sameSite = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const buy = (body: unknown = { product: "supporter" }, headers: Record<string, string> = sameSite) =>
  checkout(new Request(`${BASE}/api/checkout`, { method: "POST", headers, body: JSON.stringify(body) }), undefined as never);

/** A webhook delivery as Stripe sends it: the raw body, signed with node:crypto. */
function deliver(body: string, signature: string | null = stripeSignature(body, { t: Math.floor(clock / 1000) }), headers: Record<string, string> = {}) {
  return webhook(new Request(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { ...(signature === null ? {} : { "Stripe-Signature": signature }), ...headers }, body }));
}

function paidSession(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  return {
    id: "cs_test_paid1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    client_reference_id: userId,
    customer: "cus_test_1",
    payment_intent: "pi_test_1",
    metadata: { app: "notenote", user: userId, product: "supporter", ...metadata },
    ...overrides,
  };
}

const held = () => entitlementsOf(userId, "test");

describe("with the shop not configured", () => {
  it("lists nothing and answers 404 at checkout and the webhook, without asking Stripe", async () => {
    for (const name of Object.keys(SHOP_ENV)) delete process.env[name];
    resetIntegrations();
    expect(await (await config()).json()).toEqual({ auth: { google: false }, shop: { products: [] } });
    expect((await buy()).status).toBe(404);
    const body = stripeEvent("checkout.session.completed", paidSession());
    expect((await deliver(body)).status).toBe(404);
    expect(stripe.calls).toEqual([]);
  });
});

describe("what is for sale", () => {
  it("lists Support this app with Stripe's price, asked once an hour", async () => {
    const body = await (await config()).json();
    expect(body).toEqual({
      auth: { google: false },
      shop: { products: [{ id: "supporter", name: "Support this app", description: expect.stringContaining("supporter badge"), mode: "payment", price: { unit_amount: 300, currency: "eur" } }] },
    });
    await config();
    expect(stripe.calls).toEqual([`GET /prices/${PRICE_ID}`]);
  });

  it("lists it without a price when Stripe cannot be reached, and asks again after a minute", async () => {
    stripe.failWith = 500;
    expect((await (await config()).json()).shop.products[0]).not.toHaveProperty("price");
    stripe.failWith = null;
    await config();
    expect(stripe.calls).toHaveLength(1);
    clock += 61_000;
    expect((await (await config()).json()).shop.products[0].price).toEqual({ unit_amount: 300, currency: "eur" });
    clock -= 61_000;
  });

  it.each([
    ["inactive", { active: false }],
    ["recurring", { recurring: { interval: "month", interval_count: 1 } }],
    ["without a fixed amount", { unit_amount: null }],
  ])("does not sell it at a price that is %s", async (_what, change) => {
    stripe.prices.set(PRICE_ID, { ...stripe.prices.get(PRICE_ID)!, ...change });
    expect((await (await config()).json()).shop.products).toEqual([]);
    expect((await buy()).status).toBe(404);
    expect(stripe.sessions).toEqual([]);
  });
});

describe("checkout", () => {
  it("creates a Stripe Checkout Session for the signed-in account and answers its address", async () => {
    const res = await buy();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1abc" });
    const [session] = stripe.sessions;
    expect(Object.fromEntries(session!.params)).toEqual({
      mode: "payment",
      "line_items[0][price]": PRICE_ID,
      "line_items[0][quantity]": "1",
      client_reference_id: userId,
      "metadata[app]": "notenote",
      "metadata[user]": userId,
      "metadata[product]": "supporter",
      "payment_intent_data[metadata][app]": "notenote",
      "payment_intent_data[metadata][user]": userId,
      "payment_intent_data[metadata][product]": "supporter",
      customer_creation: "always",
      success_url: `${BASE}/settings?purchase=success`,
      cancel_url: `${BASE}/settings?purchase=cancelled`,
      expires_at: String(Math.floor(clock / 1000) + 3600),
    });
    expect(session!.idempotencyKey).toMatch(/^notenote-checkout-[A-Za-z0-9_-]{32}$/);
    // Nothing is granted for starting to pay.
    expect(held()).toEqual([]);
  });

  it("refuses a product that is not for sale, and a body that is not one", async () => {
    for (const body of [{ product: "pro" }, { product: "constructor" }, { product: ["supporter"] }, {}, null, "supporter"]) {
      expect((await buy(body)).status, JSON.stringify(body)).toBe(404);
    }
    expect(stripe.sessions).toEqual([]);
  });

  it("is refused from another site, as a form, and signed out", async () => {
    expect((await buy(undefined, { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" })).status).toBe(403);
    expect((await buy(undefined, { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" })).status).toBe(400);
    jar.clear();
    expect((await buy()).status).toBe(401);
    expect(stripe.sessions).toEqual([]);
  });

  it("is refused once the badge is held, and reuses the Stripe customer of an earlier purchase", async () => {
    const body = stripeEvent("checkout.session.completed", paidSession());
    expect((await deliver(body)).status).toBe(200);
    expect((await buy()).status).toBe(409);
    // Refunded, it can be bought again, by the same Stripe customer.
    const refund = stripeEvent("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_test_1", amount: 300, amount_refunded: 300, refunded: true });
    expect((await deliver(refund)).status).toBe(200);
    expect((await buy()).status).toBe(200);
    expect(stripe.sessions[0]!.params.get("customer")).toBe("cus_test_1");
    expect(stripe.sessions[0]!.params.has("customer_creation")).toBe(false);
  });

  it("allows ten an hour for one account", async () => {
    for (let i = 0; i < 10; i++) expect((await buy()).status).toBe(200);
    const eleventh = await buy();
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(stripe.sessions).toHaveLength(10);
  });

  it("answers 502 when Stripe fails, saying nothing Stripe said", async () => {
    await config();
    stripe.failWith = 500;
    const res = await buy();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Stripe could not be reached. Try again in a moment." });
    expect(logged).toContain("error: The Daily Scroll: checkout failed (Stripe 500)");
  });
});

describe("the webhook", () => {
  it("grants the badge for a paid checkout, once, and /api/auth/me reports it", async () => {
    const body = stripeEvent("checkout.session.completed", paidSession(), { id: "evt_paid1" });
    expect(await (await deliver(body)).json()).toEqual({ received: true });
    expect(held()).toEqual(["supporter"]);
    expect(isSupporter(userId)).toBe(true);
    expect(await (await me()).json()).toMatchObject({ user: { id: userId }, entitlements: ["supporter"] });
    // A replay of the same event changes nothing again.
    expect((await deliver(body)).status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases").get()).toEqual({ c: 1 });
    expect(getDb().prepare("SELECT id, type FROM stripe_events").all()).toEqual([{ id: "evt_paid1", type: "checkout.session.completed" }]);
  });

  it("waits for a delayed payment to succeed", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession({ payment_status: "unpaid" })));
    expect(held()).toEqual([]);
    await deliver(stripeEvent("checkout.session.async_payment_failed", paidSession({ payment_status: "unpaid" })));
    expect(held()).toEqual([]);
    await deliver(stripeEvent("checkout.session.async_payment_succeeded", paidSession()));
    expect(held()).toEqual(["supporter"]);
  });

  it.each([
    ["another app's", {}, { app: "battleshiple" }],
    ["a product not sold here", {}, { product: "pro" }],
    ["a user key of the wrong shape", { client_reference_id: "google:1234" }, { user: "google:1234" }],
    ["a client reference that disagrees", { client_reference_id: "00000000-0000-4000-8000-000000000000" }, {}],
    ["a session in another mode", { mode: "subscription" }, {}],
  ])("grants nothing for %s purchase", async (_what, overrides, metadata) => {
    expect((await deliver(stripeEvent("checkout.session.completed", paidSession(overrides, metadata)))).status).toBe(200);
    expect(held()).toEqual([]);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases").get()).toEqual({ c: 0 });
    // Not this app's purchase at all: nothing for the owner to refund, so nothing logged.
    expect(logged).toEqual([]);
  });

  it("records a free checkout under its session, having no payment intent", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession({ payment_status: "no_payment_required", payment_intent: null })));
    expect(held()).toEqual(["supporter"]);
    expect(getDb().prepare("SELECT ref FROM purchases").all()).toEqual([{ ref: "cs_test_paid1" }]);
  });

  it("leaves a purchase recorded for one account to it, whatever a later event names", async () => {
    const other = (await signUp({ email: "other@example.com", displayName: "Other", password: "password123" })).id;
    await deliver(stripeEvent("checkout.session.completed", paidSession()));
    await deliver(stripeEvent("checkout.session.async_payment_succeeded", paidSession({ client_reference_id: other }, { user: other })));
    expect(held()).toEqual(["supporter"]);
    expect(entitlementsOf(other, "test")).toEqual([]);
  });

  it("acknowledges an event it does not act on, and does not remember it", async () => {
    expect((await deliver(stripeEvent("customer.created", { id: "cus_x", object: "customer" }, { id: "evt_ignored" }))).status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM stripe_events").get()).toEqual({ c: 0 });
  });

  it("grants nothing to an account deleted before the webhook arrived, and tells the owner to refund it", async () => {
    deleteAccountData(userId);
    expect((await deliver(stripeEvent("checkout.session.completed", paidSession()))).status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases").get()).toEqual({ c: 0 });
    expect(logged).toContain("warn: The Daily Scroll: payment pi_test_1 is for an account that no longer exists; refund it in the Stripe dashboard");
  });

  it("takes the badge back for a full refund and for a dispute, not for a partial refund", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession()));
    await deliver(stripeEvent("charge.refunded", { id: "ch_1", payment_intent: "pi_test_1", amount: 300, amount_refunded: 100, refunded: false }));
    expect(held()).toEqual(["supporter"]);
    await deliver(stripeEvent("charge.refunded", { id: "ch_1", payment_intent: "pi_test_1", amount: 300, amount_refunded: 300, refunded: false }));
    expect(held()).toEqual([]);

    await deliver(stripeEvent("checkout.session.completed", paidSession({ payment_intent: "pi_test_2", id: "cs_test_paid2" })));
    expect(held()).toEqual(["supporter"]);
    await deliver(stripeEvent("charge.dispute.created", { id: "dp_1", object: "dispute", payment_intent: "pi_test_2" }));
    expect(held()).toEqual([]);
  });

  it("remembers a refund that arrives before its purchase, so the purchase grants nothing", async () => {
    await deliver(stripeEvent("charge.refunded", { id: "ch_1", payment_intent: "pi_test_1", amount: 300, amount_refunded: 300, refunded: true }));
    await deliver(stripeEvent("checkout.session.completed", paidSession()));
    expect(held()).toEqual([]);
  });

  it("keeps test-mode purchases apart from live ones", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession()));
    expect(entitlementsOf(userId, "test")).toEqual(["supporter"]);
    expect(entitlementsOf(userId, "live")).toEqual([]);
    // With the shop's variables gone the deployment reads live records: the test badge is not shown.
    for (const name of Object.keys(SHOP_ENV)) delete process.env[name];
    resetIntegrations();
    expect(isSupporter(userId)).toBe(false);
  });

  describe("refuses with 400, recording nothing", () => {
    const body = () => stripeEvent("checkout.session.completed", paidSession());
    async function refused(res: Response | Promise<Response>, status = 400) {
      expect((await res).status).toBe(status);
      expect(held()).toEqual([]);
      expect(getDb().prepare("SELECT COUNT(*) AS c FROM stripe_events").get()).toEqual({ c: 0 });
    }

    it("a delivery with no signature", async () => refused(deliver(body(), null)));
    it("a signature made with another secret", async () => {
      const b = body();
      await refused(deliver(b, stripeSignature(b, { secret: "whsec_someone_elses_secret", t: Math.floor(clock / 1000) })));
    });
    it("a signature over another body", async () => {
      const b = body();
      await refused(deliver(b.replace('"paid"', '"paid" '), stripeSignature(b, { t: Math.floor(clock / 1000) })));
    });
    it("a timestamp more than five minutes old", async () => {
      const b = body();
      await refused(deliver(b, stripeSignature(b, { t: Math.floor(clock / 1000) - 301 })));
    });
    it("a timestamp more than five minutes ahead", async () => {
      const b = body();
      await refused(deliver(b, stripeSignature(b, { t: Math.floor(clock / 1000) + 301 })));
    });
    it("a live event under a test key", async () => {
      const b = stripeEvent("checkout.session.completed", paidSession(), { livemode: true });
      await refused(deliver(b));
    });
    it("a signed body that is not JSON", async () => refused(deliver("{not json")));
    it("a body over the cap, with a length declared", async () => {
      const b = `${body()}${" ".repeat(70 * 1024)}`;
      await refused(deliver(b, stripeSignature(b, { t: Math.floor(clock / 1000) }), { "Content-Length": String(b.length) }), 413);
    });
    it("a body over the cap, sent without a length", async () => {
      const b = `${body()}${" ".repeat(70 * 1024)}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(b));
          controller.close();
        },
      });
      const res = await webhook(
        new Request(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "Stripe-Signature": stripeSignature(b, { t: Math.floor(clock / 1000) }) }, body: stream, duplex: "half" } as RequestInit),
      );
      await refused(res, 413);
    });
  });

  it("accepts a header carrying two v1 signatures of which one is right", async () => {
    const b = stripeEvent("checkout.session.completed", paidSession());
    const signature = stripeSignature(b, { t: Math.floor(clock / 1000), extra: [`v1=${"0".repeat(64)}`] });
    expect((await deliver(b, signature)).status).toBe(200);
    expect(held()).toEqual(["supporter"]);
  });

  it("answers 500 when the purchase cannot be written, so Stripe retries, and applies it on the retry", async () => {
    const b = stripeEvent("checkout.session.completed", paidSession(), { id: "evt_retry" });
    getDb().exec("ALTER TABLE stripe_events RENAME TO stripe_events_away");
    try {
      expect((await deliver(b)).status).toBe(500);
    } finally {
      getDb().exec("ALTER TABLE stripe_events_away RENAME TO stripe_events");
    }
    expect(held()).toEqual([]);
    expect((await deliver(b)).status).toBe(200);
    expect(held()).toEqual(["supporter"]);
  });

  it("forgets applied events after thirty days, and refunds that never met a purchase after ninety", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession(), { id: "evt_old" }));
    await deliver(stripeEvent("charge.refunded", { payment_intent: "pi_test_orphan", amount: 1, amount_refunded: 1 }, { id: "evt_orphan" }));
    clock += 31 * 86_400_000;
    await deliver(stripeEvent("checkout.session.async_payment_failed", paidSession(), { id: "evt_new" }));
    expect((getDb().prepare("SELECT id FROM stripe_events ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["evt_new"]);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases WHERE user_id IS NULL").get()).toEqual({ c: 1 });
    clock += 60 * 86_400_000;
    await deliver(stripeEvent("checkout.session.async_payment_failed", paidSession(), { id: "evt_newer" }));
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases WHERE user_id IS NULL").get()).toEqual({ c: 0 });
    // The purchase itself is the account's record, and is kept.
    expect(held()).toEqual(["supporter"]);
    clock -= 91 * 86_400_000;
  });
});

describe("the account", () => {
  it("exports its purchase and loses it, with the badge, when it is deleted", async () => {
    await deliver(stripeEvent("checkout.session.completed", paidSession()));
    const user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(userId) as never;
    expect(buildExport(user).purchases).toEqual([{ mode: "test", ref: "pi_test_1", product: "supporter", customer: "cus_test_1", revoked: 0, recorded_at: clock }]);
    deleteAccountData(userId);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM purchases").get()).toEqual({ c: 0 });
  });
});

describe("createIntegrations", () => {
  it("takes its way out to Stripe from what it is given, never from the environment", async () => {
    const own = createFakeStripe();
    const integrations = createIntegrations({ env: SHOP_ENV, fetch: upstreams(null, own) });
    expect((await integrations.publicConfig()).shop.products).toHaveLength(1);
    expect(own.calls).toEqual([`GET /prices/${PRICE_ID}`]);
    expect(stripe.calls).toEqual([]);
  });
});
