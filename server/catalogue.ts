/**
 * What the website sells through Stripe Checkout and its signed webhook: one "Support this app"
 * payment, and nothing else. A paid checkout grants the entitlement `supporter`, which puts a
 * supporter badge beside the account's address in the navigation; it changes nothing else, so
 * every platform, the hour and the archive stay the same for everyone. Its Stripe Price id is
 * STRIPE_PRICE_SUPPORTER.
 *
 * The shape is the shared kit's (`server/kit/config.js`, `validateCatalogue`), so the same file
 * would drive the kit's own backend; `test/integrations-config.test.ts` holds it to that check.
 * The Daily Scroll does not run the kit's backend, though: it has accounts and a database of its
 * own, so the shop is `src/lib/integrations/shop.ts`, using the kit's `stripe.js`.
 */
import type { Catalogue } from "./kit/config.js";

const catalogue = {
  app: "notenote",
  name: "The Daily Scroll",
  products: [
    {
      id: "supporter",
      name: "Support this app",
      description:
        "A one-time payment towards The Daily Scroll. It puts a supporter badge beside your account and changes nothing else: every platform, the hour and the archive stay the same for everyone.",
      mode: "payment",
      grants: "supporter",
    },
  ],
} as const satisfies Catalogue;

export default catalogue;

export type ProductId = (typeof catalogue.products)[number]["id"];
