#!/usr/bin/env node
/**
 * What the end-to-end walk of sign in with Google and the shop shares with the fake Google and
 * fake Stripe it runs the server against (`scripts/e2e-upstreams.mjs`): the test credentials the
 * server is configured with, how a consent is written into the code Google sends back, and how a
 * webhook delivery is signed. Test values only, for a scratch server on loopback; none of them
 * opens anything real.
 *
 * `node scripts/e2e-fakes.mjs --env` prints them as `export NAME=value` lines for scripts/e2e.sh.
 */
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

export const ENV = Object.freeze({
  GOOGLE_SIGNIN_CLIENT_ID: "e2e-walk.apps.googleusercontent.com",
  GOOGLE_SIGNIN_CLIENT_SECRET: "e2e-walk-google-client-secret",
  STRIPE_SECRET_KEY: "sk_test_e2eWalk0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_e2eWalk0123456789abcdef",
  STRIPE_PRICE_SUPPORTER: "price_e2eWalkSupporter",
});

/** The price the fake Stripe answers for the supporter product. */
export const PRICE = Object.freeze({ unit_amount: 300, currency: "eur" });

/**
 * A consent at the fake Google's authorize page, written into the code it sends back: the fake
 * token endpoint, in the server's process, reads who signed in and the nonce and PKCE challenge
 * of the authorize request from it, as the real one remembers them.
 */
export function consentCode({ sub, email, emailVerified = true, nonce, challenge }) {
  return Buffer.from(JSON.stringify({ sub, email, emailVerified, nonce, challenge })).toString("base64url");
}

export function readConsentCode(code) {
  try {
    const value = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** `Stripe-Signature` for a body, as Stripe signs it, with node:crypto. */
export function stripeSignature(body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", ENV.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "--env") {
  for (const [name, value] of Object.entries(ENV)) console.log(`export ${name}=${value}`);
}
