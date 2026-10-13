@AGENTS.md

## Conventions

This repository follows `CONVENTIONS.md`, which is identical in every platteration
repository and pinned by the conventions test (`npm run test:conventions`, or
`tests/test_conventions.py` in a Python repository): the script set (`test`,
`typecheck`, `lint`, `check`, `test:e2e`, `test:all`), Node 22 via `.nvmrc`, one
`.editorconfig`, ESLint per stack, the `ci.yml` shape, the documents every repository
carries and the README skeleton. The repository's check command (`npm run check`, or
`ruff check .` then `pytest -q` in a Python repository) is the gate before a push. To
change a convention, change it in every repository in one pass and update the hashes in
the test.

## Settings

Preferences are server-side: the `prefs` JSON column of the `settings` row, keyed by user,
with no client-side store, so they apply before the page is drawn. `parsePrefs` in
`src/lib/settings.ts` is the validator every read goes through, field by field with a
fallback per field, and it is where a value's shape migrates (`reduceMotion` was a boolean:
`true` reads as `on`, `false` as `system`). The boolean spelling also dates the row: under the
build that wrote it `haptic()` returned early on reduce motion, so a row still carrying `true`
reads `haptics: false` — the quiet that user already had — and the two rows are independent for
every choice made since. The enum tables live in leaf modules client components can import —
`src/lib/theme.ts` and `src/lib/motion.ts` — in two shapes, both safe against a stored value
that names something on `Object.prototype`: `REDUCE_MOTION` is a `Record<ReduceMotion, true>`
looked up by own property (`hasOwnProperty.call`, never `in`), and `THEMES` is an array
`isTheme` checks with `includes`, which a prototype name cannot match either. `resetPrefs`
(`DELETE /api/settings/prefs`, confirmed in the page) rewrites only that record; the hour,
connections and history are not preferences. The version on the About card and at
`/api/health` comes from `src/lib/version.ts`, which imports `package.json` because
`npm_package_version` is unset under a bare `next start`. `test/settings-contract.test.ts`
pins the row list and the enum tables as literals, and that the stylesheet's
`prefers-reduced-motion` block is scoped away from a root that says Off.

## The website

The app is its own host: every response (pages, API routes, `/_next/static`, `public/`, the
not-found page) gets its headers from `src/proxy.ts`, and the policy lives in
`src/lib/security-headers.ts`. The exceptions never reach the proxy: a `TRACE`, which Next
answers 500 itself, and whatever Node's HTTP parser refuses (README, "The website: headers and
hosting"). Next's image optimizer is off (`images.unoptimized`), so `/_next/image` is a 404 under
the same headers. The README's headers block is read by the tests:
`test/headers.test.ts` holds it equal to the code word for word, and `scripts/browser-walk.mjs`
(the second half of `npm run test:e2e`) loads the built app in Chromium under the headers the
server really sends and fails on any CSP violation, console error, page error, request off the
origin, or response that differs from the block. `script-src` is `'self'` plus a nonce minted
per request; the proxy writes the policy onto the request as well, which is where the framework
reads the nonce from, so every page must stay rendered per request (the root layout reads the
session cookie) — a prerendered page carries no nonce and its inline scripts are refused. Add a
source to the policy only when the walk shows something real needs it. React `style` props are
allowed (`style-src-attr 'unsafe-inline'`) but `<style>` elements are not, which is why the app
has its own `not-found.tsx`. Trusted Types was measured and breaks the framework's chunk loader.
`public/guard.js` is the safety net for a page whose scripts fail or throw before `Started`
reports in; `public/.well-known/security.txt` has an `Expires` that a test fails on once it lapses.

## Sign in with Google and the shop

Both are off until the operator sets their variables (README, "Sign in with Google and Support
this app"); with none set `/api/config` says so, every route below 404s and no page draws a
Google or Buy control. The shared kit sits at `server/kit/`, byte for byte the canonical copy:
never edit it (a change goes to the canonical copy and is copied everywhere). `npm test` runs
its self-test (`node --test server/kit/selftest.mjs`) before vitest, ESLint lints it under this
repository's configuration unchanged, and `npm run typecheck` checks its JavaScript under every
option of `tsconfig.json` through `tsconfig.kit.json` (allowJs and checkJs, which the app's own
config leaves off); the app imports it through the `.d.ts` files beside each module. This app
uses the kit's `google.js`, `stripe.js`, `crypto.js` and `http.js` from inside its own stack and
keeps its own accounts, sessions and database; the kit's `app.js`, `node.js` and `cloudflare.js`
are for apps with no server and are not run here (the catalogue test reads `validateCatalogue`
from `app.js`). The catalogue is `server/catalogue.ts`, in TypeScript because `allowJs` is off.
`src/lib/integrations/` is the configuration (`config.ts`), the Google flow (`google.ts`) and the
shop (`shop.ts`), put together by `createIntegrations({ env, fetch })`; the routes use one
instance whose way out is the global `fetch`.

- **A Google account is its `sub`, never its email.** `src/lib/google-accounts.ts`: a linked
  `sub` signs in to its account; a new one makes an account with no password (`NO_PASSWORD` in
  `auth.ts`, which `signIn` meets with the decoy hash so it costs what any wrong password does);
  an address an unlinked account already holds makes and links nothing (`?signin=exists`).
  Linking happens only from Settings, and the callback checks the browser is still signed in to
  the account that started it. Do not add a link by matching addresses: this app sends no email,
  so an address typed at sign-up proves nothing.
- **The flow's state is a signed cookie, not a row.** `__Host-notenote-oauth`, ten minutes,
  signed with SESSION_SECRET; starting a sign-in writes nothing to the database. The callback
  ends in `createSession`, after `destroySession`, as a password sign-in would.
- **Only the webhook grants.** `purchases` is written by `/api/webhooks/stripe` alone, after the
  signature and the mode check, and `stripe_events` makes each event apply once, in the same
  transaction. A purchase is per Stripe mode; `records` (the key's mode, live when none) is the
  one read, also for the nav badge, so a badge earned stays drawn if the shop is turned off.
- **No variable points the app at another Google or Stripe.** Unit tests hand fakes to
  `createIntegrations({ fetch })` or replace the global fetch (`test/helpers/fake-upstreams.ts`);
  the end-to-end run loads `scripts/e2e-upstreams.mjs` into its second server's process with
  `node --import`. Playwright does not route a request a redirect makes, which is why
  `scripts/integrations-walk.mjs` answers the sign-in start's 302 to Google as a Refresh.
- Every response here, the new routes' too, carries the site's headers from `src/proxy.ts`; the
  kit's own API headers are not used. `connect-src 'self'` already covered the API: Google and
  Checkout are navigations, and the policy did not change. `public/sw.js` has no fetch handler,
  so the callback and every `/api/` request reach the server (`test/integrations-config.test.ts`).
- A query word the page reads once (`?signin=`, `?link=`, `?purchase=`) is taken out of the
  address by `useForgetParam`, which waits a task so that the app router has patched
  `history.replaceState`; unpatched, the router's next refresh put the word back.
