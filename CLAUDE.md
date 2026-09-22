@AGENTS.md

## Conventions

This repository follows `CONVENTIONS.md`, which is identical in every platteration
repository and pinned by the conventions test (`npm run test:conventions`, or
`tests/test_conventions.py` in a Python repository): the script set (`test`,
`typecheck`, `lint`, `check`, `test:e2e`, `test:all`), Node 22 via `.nvmrc`, one
`.editorconfig`, ESLint per stack, the `ci.yml` shape, the documents every repository
carries and the README skeleton. `npm run check` is the gate before a push. To change a
convention, change it in every repository in one pass and update the hashes in the test.

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
