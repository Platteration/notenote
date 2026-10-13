/**
 * Sign in with Google and the shop, put together from the environment.
 *
 * `createIntegrations({ env, fetch })` is the whole of it, with the way out to Google and Stripe
 * handed in: tests hand it fakes. No Google or Stripe address is configurable; they are
 * constants in the shared kit (`server/kit/google.js`, `server/kit/stripe.js`). The routes use
 * one instance, made from `process.env` on first use, whose way out is the global `fetch`.
 */
import { createKeyCache, type Fetch } from "../../../server/kit/google.js";
import { readIntegrationConfig, type IntegrationConfig } from "./config";
import { createGoogleSignIn, type GoogleSignIn, type Log } from "./google";
import { createShop, entitlementsOf, type ListedProduct, type Shop } from "./shop";

export interface Integrations {
  readonly config: IntegrationConfig;
  /** Null when sign in with Google is off. */
  readonly google: GoogleSignIn | null;
  /** Null when the shop is off. */
  readonly shop: Shop | null;
  /** What `GET /api/config` answers: which features are on, and what is for sale. */
  publicConfig(): Promise<{ auth: { google: boolean }; shop: { products: ListedProduct[] } }>;
}

const consoleLog: Log = (level, message) => {
  if (level === "error") console.error(message);
  else console.warn(message);
};

export function createIntegrations(options: { env: Record<string, string | undefined>; fetch: Fetch; now?: () => number; log?: Log; timeoutMs?: number }): Integrations {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? consoleLog;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const outbound = options.fetch;
  const fetch: Fetch = (input, init) => outbound(input, init);
  const config = readIntegrationConfig(options.env);
  const google = config.signIn
    ? createGoogleSignIn({ config: config.signIn, fetch, keys: createKeyCache({ fetch, now, timeoutMs }), now, log, timeoutMs })
    : null;
  const shop = config.shop ? createShop({ config: config.shop, fetch, now, log, timeoutMs }) : null;
  return {
    config,
    google,
    shop,
    async publicConfig() {
      return { auth: { google: google !== null }, shop: { products: shop ? await shop.listed() : [] } };
    },
  };
}

let current: Integrations | null = null;

/** The routes' instance: the environment of the running server, and the global fetch. */
export function integrations(): Integrations {
  current ??= createIntegrations({ env: process.env, fetch: (input, init) => globalThis.fetch(input, init) });
  return current;
}

/** Only for tests: the next `integrations()` reads the environment again. */
export function resetIntegrations(): void {
  current = null;
}

/**
 * Whether an account holds the supporter badge, under the Stripe mode this deployment reads
 * (live when no key is set), so a badge earned stays drawn if the shop is turned off later.
 */
export function isSupporter(userId: string): boolean {
  return entitlementsOf(userId, integrations().config.records).includes("supporter");
}
