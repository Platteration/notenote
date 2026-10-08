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
`src/lib/security-headers.ts`. The README's headers block is read by the tests:
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
