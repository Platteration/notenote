import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_ID, CLIENT_SECRET, PRICE_ID, STRIPE_KEY, WEBHOOK_SECRET } from "./helpers/fake-upstreams";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-about-privacy-tests";

const { AboutCard } = await import("@/components/AboutCard");
const { resetIntegrations } = await import("@/lib/integrations");
const { GOOGLE_PRIVACY, STRIPE_PRIVACY } = await import("@/lib/site-config");

const SIGN_IN = { APP_BASE_URL: "https://scroll.example", GOOGLE_SIGNIN_CLIENT_ID: CLIENT_ID, GOOGLE_SIGNIN_CLIENT_SECRET: CLIENT_SECRET };
const SHOP = { APP_BASE_URL: "https://scroll.example", STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_SUPPORTER: PRICE_ID };

function about(env: Record<string, string>): string {
  for (const name of [...Object.keys(SIGN_IN), ...Object.keys(SHOP)]) delete process.env[name];
  Object.assign(process.env, env);
  resetIntegrations();
  // React escapes the apostrophes; the sentences are compared as the page reads them.
  return renderToStaticMarkup(AboutCard()).replaceAll("&#x27;", "'");
}

afterEach(() => {
  for (const name of [...Object.keys(SIGN_IN), ...Object.keys(SHOP)]) delete process.env[name];
  resetIntegrations();
});

describe("what the About card says leaves this server", () => {
  it("names neither Google nor Stripe where neither is turned on", () => {
    const text = about({});
    expect(text).toContain("live on this server only");
    expect(text).not.toMatch(/Google|Stripe/);
  });

  it("says what Google tells the server, exactly where sign in with Google is on", () => {
    const text = about(SIGN_IN);
    expect(text).toContain(GOOGLE_PRIVACY);
    expect(text).not.toContain(STRIPE_PRIVACY);
  });

  it("says what Stripe handles and the server keeps, exactly where the shop is on", () => {
    const text = about(SHOP);
    expect(text).toContain(STRIPE_PRIVACY);
    expect(text).not.toContain(GOOGLE_PRIVACY);
    expect(about({ ...SIGN_IN, ...SHOP })).toContain(`${GOOGLE_PRIVACY} ${STRIPE_PRIVACY}`);
  });
});
