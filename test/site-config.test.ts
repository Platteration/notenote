import { describe, expect, it } from "vitest";
import {
  formatPrice,
  googleStartHref,
  isCheckoutUrl,
  isGoogleConsentUrl,
  linkNotice,
  readSiteConfig,
  signInNotice,
  SITE_OFF,
  thanks,
  withoutParam,
} from "@/lib/site-config";

const CONFIGURED = JSON.stringify({
  auth: { google: true },
  shop: { products: [{ id: "supporter", name: "Support this app", description: "A one-time payment.", mode: "payment", price: { unit_amount: 300, currency: "eur" } }] },
});

describe("what a page reads from /api/config", () => {
  it("is nothing configured for a 404, a body that is not JSON, or nothing turned on", () => {
    expect(readSiteConfig(404, CONFIGURED)).toEqual(SITE_OFF);
    expect(readSiteConfig(500, CONFIGURED)).toEqual(SITE_OFF);
    expect(readSiteConfig(200, "<!doctype html><p>a host's own page")).toEqual(SITE_OFF);
    expect(readSiteConfig(200, "null")).toEqual(SITE_OFF);
    expect(readSiteConfig(200, "[]")).toEqual(SITE_OFF);
    expect(readSiteConfig(200, JSON.stringify({ auth: { google: false }, shop: { products: [] } }))).toEqual(SITE_OFF);
    expect(SITE_OFF).toEqual({ google: false, products: [] });
  });

  it("draws what a configured server lists", () => {
    expect(readSiteConfig(200, CONFIGURED)).toEqual({
      google: true,
      products: [{ id: "supporter", name: "Support this app", description: "A one-time payment.", mode: "payment", price: { unit_amount: 300, currency: "eur" } }],
    });
  });

  it("reads each field for what it is, leaving out what does not hold up", () => {
    const body = JSON.stringify({
      auth: { google: "yes" },
      shop: {
        products: [
          { id: "supporter", name: "Support", description: "", mode: "payment", price: { unit_amount: -1, currency: "eur" } },
          { id: "x", name: { toString: "boom" }, description: "", mode: "payment" },
          { id: "y", name: "Y", description: "", mode: "lifetime" },
          "not a product",
        ],
      },
    });
    expect(readSiteConfig(200, body)).toEqual({ google: false, products: [{ id: "supporter", name: "Support", description: "", mode: "payment" }] });
  });
});

describe("prices", () => {
  it("are in the currency's smallest unit as Stripe counts it", () => {
    // Intl writes a no-break space between a currency code and the amount.
    const shown = (unit_amount: number, currency: string) => formatPrice({ unit_amount, currency }, "en-GB").replace(/\s/g, " ");
    expect(shown(300, "eur")).toBe("€3.00");
    expect(shown(499, "jpy")).toBe("JP¥499");
    expect(shown(1500, "kwd")).toBe("KWD 1.500");
  });
});

describe("where the page will send the browser", () => {
  it("is Stripe's own Checkout and nowhere else, for Buy", () => {
    expect(isCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(true);
    for (const url of ["https://checkout.stripe.com.evil.example/c", "http://checkout.stripe.com/c", "javascript:alert(1)", "/settings", "https://evil.example/https://checkout.stripe.com/", null, 1]) {
      expect(isCheckoutUrl(url), String(url)).toBe(false);
    }
  });

  it("is Google's own consent page and nowhere else, for Link Google", () => {
    expect(isGoogleConsentUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
    for (const url of ["https://accounts.google.com.evil.example/", "https://evil.example/?https://accounts.google.com/", "http://accounts.google.com/"]) {
      expect(isGoogleConsentUrl(url), url).toBe(false);
    }
  });

  it("starts a Google sign-in with where to land and the browser's timezone", () => {
    expect(googleStartHref(null, null)).toBe("/api/auth/google/start");
    expect(googleStartHref("/saved?x=1", "Europe/London")).toBe("/api/auth/google/start?return=%2Fsaved%3Fx%3D1&tz=Europe%2FLondon");
  });

  it("takes one parameter out of the address once it has been read", () => {
    expect(withoutParam("https://scroll.example/?signin=failed", "signin")).toBe("/");
    expect(withoutParam("https://scroll.example/settings?link=done&x=1#a", "link")).toBe("/settings?x=1#a");
  });
});

describe("the words", () => {
  it("are the charter's where it gives them", () => {
    expect(signInNotice("failed")).toBe("Sign-in didn't complete.");
    expect(thanks("Support this app")).toBe("Thank you — Support this app is unlocked.");
    expect(signInNotice(null)).toBeNull();
    expect(linkNotice(null)).toBeNull();
  });

  it("say a sign-in or a link failed for any word they do not know, a name on Object.prototype included", () => {
    for (const name of [...Object.getOwnPropertyNames(Object.prototype), "nonsense"]) {
      expect(signInNotice(name), name).toBe("Sign-in didn't complete.");
      expect(linkNotice(name), name).toEqual({ kind: "err", text: "Linking Google didn't complete." });
    }
    expect(signInNotice("exists")).toMatch(/link Google from Settings/);
    expect(linkNotice("taken")?.text).toBe("That Google account already signs in to another account here.");
  });
});
