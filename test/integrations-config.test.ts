import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalogue from "../server/catalogue";
import { priceVariable as kitPriceVariable, validateCatalogue } from "../server/kit/config.js";
import { priceVariable, readIntegrationConfig, signInOrigin } from "@/lib/integrations/config";
import { CLIENT_ID, CLIENT_SECRET, PRICE_ID, STRIPE_KEY, WEBHOOK_SECRET } from "./helpers/fake-upstreams";

const SIGN_IN = {
  APP_BASE_URL: "https://scroll.example",
  SESSION_SECRET: "a-session-secret-of-plenty-of-characters",
  GOOGLE_SIGNIN_CLIENT_ID: CLIENT_ID,
  GOOGLE_SIGNIN_CLIENT_SECRET: CLIENT_SECRET,
};
const SHOP = {
  APP_BASE_URL: "https://scroll.example",
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SUPPORTER: PRICE_ID,
};

describe("the catalogue", () => {
  it("is one the shared kit accepts as it is, selling one product that grants the supporter badge", () => {
    expect(validateCatalogue(catalogue)).toEqual(catalogue);
    expect(catalogue.products.map((p) => [p.id, p.name, p.mode, p.grants])).toEqual([["supporter", "Support this app", "payment", "supporter"]]);
  });

  it("names each product's price variable as the kit does", () => {
    for (const p of catalogue.products) expect(priceVariable(p.id)).toBe(kitPriceVariable(p.id));
    expect(priceVariable("supporter")).toBe("STRIPE_PRICE_SUPPORTER");
  });
});

describe("what the environment turns on", () => {
  it("is nothing, and says nothing, when nothing is set", () => {
    expect(readIntegrationConfig({})).toEqual({ signIn: null, shop: null, records: "live", warning: null });
    // A deployment that connects YouTube has GOOGLE_CLIENT_ID set already: that is not sign-in.
    expect(readIntegrationConfig({ APP_BASE_URL: "https://scroll.example", SESSION_SECRET: SIGN_IN.SESSION_SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET })).toEqual(
      { signIn: null, shop: null, records: "live", warning: null },
    );
  });

  it("turns sign in with Google on with everything it needs, and builds every address from APP_BASE_URL", () => {
    const { signIn, shop, warning } = readIntegrationConfig(SIGN_IN);
    expect(signIn).toEqual({ origin: "https://scroll.example", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, secret: SIGN_IN.SESSION_SECRET, redirectUri: "https://scroll.example/api/auth/google/callback" });
    expect(shop).toBeNull();
    expect(warning).toBeNull();
  });

  it.each(Object.keys(SIGN_IN))("keeps sign-in off without %s, and names it, never a value", (name) => {
    const env: Record<string, string> = { ...SIGN_IN };
    delete env[name];
    const { signIn, warning } = readIntegrationConfig(env);
    expect(signIn).toBeNull();
    expect(warning).toContain(`missing ${name}`);
    for (const value of Object.values(SIGN_IN)) if (value.length > 20) expect(warning).not.toContain(value);
  });

  it.each([
    ["APP_BASE_URL", "http://scroll.example"],
    ["APP_BASE_URL", "https://scroll.example/scroll"],
    ["APP_BASE_URL", "https://scroll.example/?x=1"],
    ["APP_BASE_URL", "not a url"],
    ["SESSION_SECRET", "short"],
    ["GOOGLE_SIGNIN_CLIENT_ID", "1234.example.com"],
    ["GOOGLE_SIGNIN_CLIENT_SECRET", "tiny"],
  ])("keeps sign-in off when %s is %j, and says it is malformed", (name, value) => {
    const { signIn, warning } = readIntegrationConfig({ ...SIGN_IN, [name]: value });
    expect(signIn).toBeNull();
    expect(warning).toContain(`malformed ${name}`);
    expect(warning).not.toContain(value);
  });

  it("accepts plain http on the machine itself only", () => {
    expect(signInOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(signInOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(signInOrigin("http://192.168.1.20:3000")).toBeNull();
    expect(signInOrigin("https://user:pass@scroll.example")).toBeNull();
    expect(signInOrigin("https://scroll.example#x")).toBeNull();
  });

  it("turns the shop on without Google sign-in, since every account here can buy, and reads its mode from the key", () => {
    const { signIn, shop, records, warning } = readIntegrationConfig(SHOP);
    expect(signIn).toBeNull();
    expect(shop).toEqual({ origin: "https://scroll.example", key: STRIPE_KEY, mode: "test", webhookSecret: WEBHOOK_SECRET, prices: new Map([["supporter", PRICE_ID]]) });
    expect(records).toBe("test");
    expect(warning).toBeNull();
    expect(readIntegrationConfig({ ...SHOP, STRIPE_SECRET_KEY: "rk_live_0123456789abcdefghij" }).records).toBe("live");
  });

  it.each(Object.keys(SHOP))("keeps the shop off without %s, and names it", (name) => {
    const env: Record<string, string> = { ...SHOP };
    delete env[name];
    const { shop, warning } = readIntegrationConfig(env);
    expect(shop).toBeNull();
    expect(warning).toContain(`missing ${name}`);
  });

  it.each([
    ["STRIPE_SECRET_KEY", "pk_test_0123456789abcdefghij"],
    ["STRIPE_WEBHOOK_SECRET", "secret_0123456789"],
    ["STRIPE_PRICE_SUPPORTER", "prod_123"],
  ])("keeps the shop off when %s is %j, and says it is malformed", (name, value) => {
    const { shop, warning } = readIntegrationConfig({ ...SHOP, [name]: value });
    expect(shop).toBeNull();
    expect(warning).toContain(`malformed ${name}`);
    expect(warning).not.toContain(value);
  });
});

describe("the service worker", () => {
  it("intercepts no request, so Google's redirect back to the callback and every /api/ call reach the server", () => {
    // public/sw.js handles notifications only. A worker answering in-scope navigations from a
    // cache would swallow the sign-in callback; this one has no fetch handler at all.
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/\bonfetch\b/);
    expect(sw).not.toMatch(/\bcaches\b/);
  });
});
