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
`true` reads as `on`, `false` as `system`). The enum tables live in leaf modules client
components can import — `src/lib/theme.ts` and `src/lib/motion.ts` — as `Record<Union, true>`
with own-property lookups. `resetPrefs` (`DELETE /api/settings/prefs`, confirmed in the page)
rewrites only that record; the hour, connections and history are not preferences. The
version on the About card and at `/api/health` comes from `src/lib/version.ts`, which imports
`package.json` because `npm_package_version` is unset under a bare `next start`.
`test/settings-contract.test.ts` pins the row list and the enum tables as literals.
