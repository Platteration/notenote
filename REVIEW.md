# The Daily Scroll (notenote) — security & upgrade review (2026-09-09)

Two independent reviewers read every first-party file in this repository; a third then re-read each security or bug claim against the code and tried to refute it. Only claims that survived that check are listed as findings; the ones that did not are recorded at the end so they are not re-raised.

## Status — what has been fixed

These findings are now fixed on `claude/repo-review-security-baiyud`, each with a regression test:

- **SEC-1**
- **SEC-2**
- **SEC-3**
- **BUG-1**
- **MISS-1**

The rest of this document is the review as written, and the fixed items are left in place so the reasoning behind each change stays with it.

Repository hardening applied here as well: every GitHub Action is pinned to a commit rather than a floating tag, each workflow declares a least-privilege `permissions` block, and a Dependabot config, a licence and a security policy are in place.

## Summary

The Daily Scroll is a Next.js 16.3 / React 19.2 / TypeScript app that aggregates short-form video from ten social platforms (OAuth adapters under src/lib/providers, plus a keyless Bluesky app-password path and a demo catalogue) into one deterministic, platform-balanced feed that is open for exactly sixty minutes a day; storage is node:sqlite with no native deps, and it ships Web Push, PWA install, four WCAG-checked themes, saved shelf, creator muting, streaks and account controls. It is a three-day-old but unusually well-engineered solo project: 15 commits, 7.9k lines, twelve vitest suites covering curation, window maths, net-guard, rate limiting, password timing and push, a curl smoke test, and two CI workflows; core deps (Next, React, TS) are current while eslint 9.39 (marked unsupported in the lockfile), vitest 3.2 and Node 22 lag a major. Headline findings: (1) a real defect where streaks and the hour recap read from daily_feeds, which purgeExpired deletes a day after closing, so streaks can never exceed two days once the sweep runs; (2) the outbound HTTP helper follows redirects, letting a public Bluesky host redirect the server to an internal address around the net-guard; (3) the scroll re-renders all forty slides every second because the time bar ticks in the parent; (4) every thrown error becomes a 400 with its raw message and nothing is logged. Recommended next steps: fix those four, add security headers, Dependabot, a LICENSE, pinned actions, a durable show-up ledger, an early-close action, inline playback (Bluesky HLS is already returned by the API and discarded), and a Playwright+axe suite that enforces the accessibility claim the README already makes.

## Attack surface

The Daily Scroll is a self-hosted Next.js 16 app with open self-registration, so every authenticated API path is reachable by anyone who signs up. Unauthenticated surface: POST /api/auth/signup, /login, /logout, GET /api/auth/me, GET /api/push/key, and the OAuth start/callback redirects. Authenticated JSON surface: feed, seen-marking, settings, saved shelf, muted creators, push subscriptions, account export/delete/password/sessions, and per-provider connect/disconnect (including a credential form that accepts a Bluesky app password and a user-chosen PDS host). Two POST cron endpoints are gated by a static CRON_SECRET bearer token. Outbound, the server fetches ten fixed platform APIs, the user-chosen Bluesky service host (checked by a DNS/IP guard), and every user-supplied Web Push endpoint (unchecked). All state lives in one SQLite file: scrypt password hashes, AES-256-GCM encrypted OAuth/Bluesky tokens, plaintext session tokens, and cached third-party timeline content. Rate limiting is in-process and keyed on proxy headers; there is no CSP or other security-header configuration, and CSRF defence rests entirely on the SameSite=Lax cookie.

## Already done well

- Every SQL statement is parameterised; table names in the one templated DELETE are a hard-coded list (src/lib/db.ts, src/lib/library.ts, src/lib/feed.ts, src/app/api/account/route.ts:15-19).
- Password hashing uses async scrypt with a per-user salt and timingSafeEqual, and sign-in hashes against a decoy for unknown addresses so response time does not reveal registered emails; a test guards the property (src/lib/crypto.ts:56-81, src/lib/auth.ts:49-55, test/password.test.ts:89-128).
- OAuth state is random, single-use, bound to user and provider, expires in 15 minutes, and Google/X use PKCE S256 (src/app/api/connect/[provider]/callback/route.ts:35-41, src/lib/providers/youtube.ts:66-67, src/lib/providers/twitter.ts:65-66).
- Provider tokens are AES-256-GCM encrypted at rest with a random IV; the Bluesky app password is used once and never stored (src/lib/crypto.ts:29-46, src/lib/providers/bluesky.ts:99-118, src/app/api/connect/[provider]/credentials/route.ts:1-6).
- The outbound network guard parses IPv6 (including IPv4-mapped/compatible forms and bracketed literals), rejects every private/reserved range in both families, requires all resolved addresses to be public, and is re-run on every use of the host; it has a thorough test suite (src/lib/net-guard.ts, src/lib/providers/bluesky.ts:75-79, test/net-guard.test.ts).
- Session cookie is HttpOnly, SameSite=Lax, Secure in production, path-scoped, and demo connections are deliberately POST rather than GET to avoid Lax-GET CSRF (src/lib/session.ts:15-21, src/app/api/connect/[provider]/route.ts:7-21).
- Server-side ownership checks on every write path: saved clips must exist in the user's own frozen feeds, seen keys are validated against recent feeds, push-subscription DELETE is scoped to the caller, muting is capped at 500 and push devices at 20 (src/lib/library.ts:17-31,63-71, src/lib/feed.ts:148-166, src/app/api/push/subscribe/route.ts:19-22, src/lib/push.ts:51-68).
- Boot-time configuration validation refuses to start production without a >=16 char SESSION_SECRET, with a relative APP_BASE_URL, or with half a VAPID pair (src/instrumentation.ts:8-33).
- Per-request timeouts and per-provider budgets bound every upstream call, with stale-cache fallback and tests against a real hung socket (src/lib/providers/http.ts:29-45, src/lib/connections.ts:26-36, test/resilience.test.ts:29-141).
- Data export excludes access tokens; account deletion clears every user table including provider_cache and oauth_states, and foreign keys are enabled so push_subscriptions cascade (src/app/api/account/export/route.ts:1-5,17-19, src/app/api/account/route.ts:14-21, src/lib/db.ts:149).
- Changing a password revokes all other sessions while keeping the current device; a separate 'sign out other devices' action exists (src/lib/auth.ts:69-98, src/app/api/account/sessions/route.ts).
- No dangerouslySetInnerHTML or innerHTML anywhere; demo poster SVGs XML-escape user-visible text; external links carry rel=noopener noreferrer (grep of src/, src/lib/providers/demo.ts:142-144, src/components/ScrollView.tsx:83-90).
- The service worker does no caching at all, so there is no cache-poisoning or stale-update surface (public/sw.js:1-4).
- Supply chain hygiene: lockfile v3 with all 512 packages resolved from registry.npmjs.org with integrity hashes, npm ci in CI, npm audit clean, no first-party install hooks (package-lock.json, .github/workflows/ci.yml:26).
- Cron endpoints fail closed when CRON_SECRET is unset and require a bearer token; all API responses carry Cache-Control: no-store (src/app/api/cron/prewarm/route.ts:15-18, src/app/api/cron/notify/route.ts:14-18, src/lib/api.ts:6).

## Findings (19)

| # | Severity | Category | Title | Where | Effort | Status |
|---|---|---|---|---|---|---|
| SEC-1 | High | security | Bluesky host guard is bypassed by HTTP redirects: SSRF into the internal network with partial response disclosure | `src/lib/providers/http.ts:34` | small | confirmed |
| SEC-2 | Medium | security | Login/signup CSRF: JSON routes accept cross-site text/plain form posts, letting an attacker sign a victim into an attacker-controlled account | `src/lib/api.ts:31` | small | confirmed |
| SEC-3 | Medium | security | Rate limiting keyed on attacker-controlled X-Forwarded-For, and the per-IP bucket is cleared by any successful login | `src/lib/rate-limit.ts:63` | small | confirmed |
| BUG-1 | Medium | bug | Streak counter can never exceed two days because feeds are purged a day after they close | `src/lib/feed.ts:184` | small | confirmed |
| MISS-1 | Medium | security | Without a proxy every client shares the rate-limit key "unknown": 21 anonymous requests lock sign-in for the whole deployment | `src/lib/rate-limit.ts:64` | small | found by second reviewer |
| SEC-4 | Low | security | Post-login open redirect through the ?next= parameter | `src/components/AuthForm.tsx:33` | trivial | confirmed |
| SEC-5 | Low | security | Web Push endpoints are user-supplied URLs the server POSTs to with no network guard (blind SSRF) | `src/lib/push.ts:43` | trivial | confirmed |
| SEC-6 | Low | security | Session bearer tokens stored in plaintext in the database | `src/lib/session.ts:11` | small | confirmed |
| SEC-7 | Low | security | No security headers: no CSP, no frame-ancestors/X-Frame-Options, no Referrer-Policy or HSTS, X-Powered-By left on | `next.config.ts:3` | small | confirmed |
| SEC-8 | Low | security | Internal error messages are returned verbatim to clients and persisted into feed payloads | `src/lib/api.ts:11` | small | confirmed |
| SEC-9 | Low | reliability | No request-body or field-length limits on the unauthenticated auth routes; login parses the body before rate limiting | `src/app/api/auth/login/route.ts:23` | trivial | confirmed |
| REL-1 | Low | reliability | Token-encryption key is derived directly from SESSION_SECRET with no key id, so rotating the secret silently bricks every connection | `src/lib/crypto.ts:24` | small | confirmed |
| CI-1 | Low | ci-cd | GitHub Actions unpinned by SHA, no permissions block, no dependency-update automation | `.github/workflows/ci.yml:18` | trivial | confirmed |
| MISS-2 | Low | security | Nothing bounds the size of a provider response or of the items derived from it, so a hostile Bluesky PDS can inflate memory, the SQLite file and every later read of it | `src/lib/providers/http.ts:42` | small | found by second reviewer |
| MISS-3 | Low | reliability | First-of-the-hour feed generation has no rate limit and no single-flight guard, so concurrent requests fan out to every connected platform in parallel | `src/lib/feed.ts:63` | small | found by second reviewer |
| MISS-4 | Low | security | Push subscriptions are keyed globally by endpoint and the upsert reassigns user_id, letting one account claim another's device | `src/lib/push.ts:56` | trivial | found by second reviewer |
| MISS-5 | Low | security | Outside NODE_ENV=production every OAuth token is encrypted with a hard-coded key committed to the repository, and the startup checks are skipped | `src/lib/crypto.ts:21` | trivial | found by second reviewer |
| SEC-10 | Info | security | scrypt uses Node's default cost (N=16384), below current OWASP guidance | `src/lib/crypto.ts:58` | small | confirmed |
| SEC-11 | Info | security | CRON_SECRET compared with a plain string equality | `src/app/api/cron/notify/route.ts:16` | trivial | confirmed |

### SEC-1 · Bluesky host guard is bypassed by HTTP redirects: SSRF into the internal network with partial response disclosure

**Severity:** High · **Category:** security · **Effort:** small · **Where:** `src/lib/providers/http.ts:34`

assertPublicHost() vets only the hostname the user typed; getJson() then calls fetch() with the default redirect mode (verified: Request.redirect defaults to 'follow' on Node 22). Any registered user can enter a service host they control (a public IP with a valid certificate), have it answer /xrpc/com.atproto.server.createSession with a 302/307 to http://169.254.169.254/..., http://127.0.0.1:PORT/... or any RFC1918 address, and the server follows it unguarded. The README presents this guard as the control ('It runs before every request to that host'), but one redirect hop defeats it. Response content leaks back to the attacker through three channels: a non-2xx upstream reply puts its first 200 bytes into ProviderHttpError.message, which is returned verbatim by the credentials route and stored in sources[].error of the feed payload; a 2xx non-JSON reply leaks its first ~10 bytes via V8's JSON.parse message (verified: "Unexpected token 'a', \"arn:aws:ia\"... is not valid JSON"); and a 2xx JSON reply containing error/message keys is echoed as 'Bluesky: <message>'. Differing error text and timing also give a port/host scanner. On a cloud host this is a path to instance-metadata credentials; on a home server it reaches admin panels on the LAN. Reachable by anyone who can sign up (open registration).

Evidence:

```
src/lib/providers/http.ts:34 `res = await fetch(url, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(timeout) });` (no redirect option) | src/lib/providers/http.ts:24 `super(`${provider} API responded ${status}: ${body.slice(0, 200)}`);` | src/lib/providers/http.ts:44 `return JSON.parse(text) as T;` | src/lib/providers/bluesky.ts:77 `await assertPublicHost(new URL(service).hostname);` (only the typed host) | src/lib/providers/bluesky.ts:109 `if (session.error) throw new Error(`Bluesky: ${session.message ?? session.error}`);` | src/app/api/connect/[provider]/credentials/route.ts:40-41 `const message = err instanceof Error ? err.message : "Could not connect"; return json({ error: message }, { status: 400 });` | src/lib/connections.ts:194-199 error text stored into the feed's sources[].error
```

**Recommendation.** As written, plus one addition: whatever hop-checking loop replaces the default follow must also bound the response body. getJson() does `await res.text()` with no size cap (http.ts:42), so a hostile PDS can still stream an unbounded body inside the 8s timeout. Read through a counting stream and abort past a few hundred KB in the same change.

### SEC-2 · Login/signup CSRF: JSON routes accept cross-site text/plain form posts, letting an attacker sign a victim into an attacker-controlled account

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `src/lib/api.ts:31`

readJson() calls req.json() with no Content-Type or Origin/Sec-Fetch-Site check, and POST /api/auth/login and /signup need no existing cookie, so SameSite=Lax does not protect them. A cross-site <form method=POST enctype="text/plain"> whose single field is named `{"email":"attacker@x","password":"pw","x":"` with value `"}` produces a body that is valid JSON; the browser sends it as a top-level navigation without preflight, and the response's Set-Cookie is honoured. The victim is now silently signed in as the attacker. Because this app's entire value is the platform tokens a user connects, the next time the victim clicks Connect on YouTube/X/Reddit or types a Bluesky app password, those credentials and their home-timeline content land in the attacker's account, readable via /api/feed and /api/account/export. The Settings page shows only the display name prominently, so the swap is easy to miss.

Evidence:

```
src/lib/api.ts:29-35 `export async function readJson<T>(req: Request): Promise<T> { try { return (await req.json()) as T; } catch { throw new Error("Request body must be JSON"); } }` | src/app/api/auth/login/route.ts:23 `const body = await readJson<{ email?: string; password?: string }>(req);` ... :45 `await createSession(user.id);` | src/lib/session.ts:15-21 cookie set on the login response
```

**Recommendation.** Add a small guard used by every mutating route (or a middleware for /api/*): reject unless `req.headers.get("sec-fetch-site")` is `same-origin`/`none` or, for older browsers, the `Origin` header matches APP_BASE_URL; additionally make readJson() require `Content-Type: application/json`. A cross-site form cannot set either header. Example: `const site = req.headers.get("sec-fetch-site"); const origin = req.headers.get("origin"); if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== appBaseUrl())) return json({ error: "Cross-site request refused" }, { status: 403 });`. Show the signed-in email in the Nav so an unexpected account is visible.

### SEC-3 · Rate limiting keyed on attacker-controlled X-Forwarded-For, and the per-IP bucket is cleared by any successful login

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `src/lib/rate-limit.ts:63`

clientKey() takes the first X-Forwarded-For entry (then x-real-ip) without any notion of a trusted proxy. When the app is exposed directly, or behind a proxy that appends rather than replaces the header, a client picks its own key per request. The project's own smoke test relies on exactly this to get a fresh bucket. Consequences: the 5/hour signup limit is fully bypassable (unbounded bulk registration, which also feeds SEC-1); the per-IP and per-account+IP login limits are bypassable, leaving only PER_ACCOUNT at 100 guesses per 15 minutes per email (~9,600/day) as the real online-guessing ceiling; the password-change limiter (keyed user+ip, no account-wide cap) becomes unlimited for a hijacked session. Separately, a successful login clears `login:ip:<ip>` for that IP, so an attacker with their own account can reset the per-IP bucket at will between guesses against other accounts.

Evidence:

```
src/lib/rate-limit.ts:61-65 `const forwarded = req.headers.get("x-forwarded-for"); if (forwarded) return forwarded.split(",")[0]!.trim(); return req.headers.get("x-real-ip") ?? "unknown";` | src/app/api/auth/login/route.ts:26-31 buckets keyed on `ip` and `${email}:${ip}` | src/app/api/auth/login/route.ts:43-44 `clearRateLimit(`login:acct-ip:${email}:${ip}`); clearRateLimit(`login:ip:${ip}`);` | scripts/smoke.sh:69 `-H 'X-Forwarded-For: 203.0.113.250'` used to obtain a fresh limiter bucket | src/app/api/auth/signup/route.ts:11 signup limited only per spoofable IP
```

**Recommendation.** Same, but note that 'with 0 hops ... fall back to a single shared key' is exactly the failure mode in MISS-1 below: a single shared key turns every limiter into a global one and hands an unauthenticated attacker a deployment-wide sign-in lockout. With 0 trusted hops the honest options are to disable the IP-keyed buckets entirely (keeping only the account-keyed ones) or to read the socket address, not to collapse everyone onto one bucket.

### BUG-1 · Streak counter can never exceed two days because feeds are purged a day after they close

**Severity:** Medium · **Category:** bug · **Effort:** small · **Where:** `src/lib/feed.ts:184`

streakFor() derives 'current', 'longest' and 'total' entirely from rows in daily_feeds, but purgeExpired() (run hourly by ordinary requests and by the prewarm cron) deletes any daily_feeds row whose hour closed more than 24 hours ago. A user who shows up every day therefore sees a streak of 1 on the locked screen before their hour and 2 at most afterwards, and 'longest run' and total days are equally truncated. The README promises 'a streak of consecutive days you turned up for your hour'. test/library.test.ts passes only because it seeds daily_feeds directly and never runs the purge. This regressed when the sweep was added in commit 5528d8d after streaks landed in ebda24f.

Evidence:

```
src/lib/feed.ts:184 `const feeds = db.prepare("DELETE FROM daily_feeds WHERE closes_at < ?").run(at - 86_400_000);` | src/lib/library.ts:117-122 `export function streakFor(userId: string, todayKey: string): Streak { const days = ( getDb().prepare("SELECT day_key FROM daily_feeds WHERE user_id = ? ORDER BY day_key DESC").all(userId) ...` | README.md 'The locked screen shows a streak of consecutive days you turned up for your hour.'
```

**Recommendation.** The hour_opens ledger is the right shape, but the insert must go where the *user opens* the hour, not merely where a row is created: getFeed() only inserts daily_feeds on the first open request of the day (feed.ts:90-93), while the prewarm cron calls collectItems() without touching daily_feeds, so a ledger written there stays honest. Also add the new table to the DELETE list in src/app/api/account/route.ts:15 (or give it ON DELETE CASCADE, which the other per-user tables already have) and to the export payload.

### MISS-1 · Without a proxy every client shares the rate-limit key "unknown": 21 anonymous requests lock sign-in for the whole deployment

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `src/lib/rate-limit.ts:64`

The first auditor covered the spoofing direction of clientKey() but not its opposite, which is the default deployment. The README's operating instructions are `npm start` with no reverse proxy mentioned anywhere, and next start does not synthesise X-Forwarded-For, so for every direct client clientKey() falls through to the literal string "unknown". Every IP-keyed bucket then becomes a single global bucket. POST /api/auth/login limits `login:ip:unknown` to 20 per 15 minutes across all users, so an unauthenticated attacker sending 21 wrong sign-in attempts blocks sign-in for every user of the server; the bucket cannot recover early because clearRateLimit only runs after a successful sign-in (login/route.ts:43-44) and the limiter check runs first, so no one can log in to clear it. The window is fixed-length, so ~21 requests every 15 minutes sustains the lockout indefinitely at negligible cost. The same collapse caps registration at 5 accounts per hour for the entire deployment, with no clear-on-success at all. Note this is the mirror image of SEC-3, so any fix must handle both: a client that sends X-Forwarded-For gets a private bucket, and one that does not shares everyone else's.

Evidence:

```
src/lib/rate-limit.ts:61-65 `export function clientKey(req: Request): string { const forwarded = req.headers.get("x-forwarded-for"); if (forwarded) return forwarded.split(",")[0]!.trim(); return req.headers.get("x-real-ip") ?? "unknown"; }` | src/app/api/auth/login/route.ts:17,26-39 `const PER_IP = { limit: 20, windowMs: 15 * 60_000 };` ... `const ip = clientKey(req); const checks = [rateLimit(`login:ip:${ip}`, PER_IP.limit, PER_IP.windowMs)]; ... if (blocked.length > 0) { ... return json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429, ... }); }` (the limiter gates the request before signIn at :41, so the clear at :44 is unreachable while blocked) | src/app/api/auth/signup/route.ts:7,11 `const PER_IP = { limit: 5, windowMs: 60 * 60_000 };` / `rateLimit(`signup:ip:${clientKey(req)}`, ...)` | src/lib/rate-limit.ts:36-43 (fixed window; resetAt is not extended by further requests) | README.md:233 `npm start           # serve the build` - no proxy is described anywhere in the file
```

**Recommendation.** Make the absence of a trusted forwarding header explicit rather than silent. Add a TRUSTED_PROXY_HOPS setting (default 0); with 0 hops ignore X-Forwarded-For/X-Real-IP entirely and skip the IP-keyed buckets, relying on the account-keyed ones (`login:acct:${email}` already exists and is not spoofable) plus a global signup ceiling that is deliberately generous; with N hops take the Nth-from-the-right XFF entry. Never let an unidentifiable client land in a bucket shared with identifiable ones. Document in the README that a reverse proxy which overwrites X-Forwarded-For is required for per-client throttling, and add a rate-limit test asserting that two requests with no forwarding headers do not consume each other's budget.

### SEC-4 · Post-login open redirect through the ?next= parameter

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `src/components/AuthForm.tsx:33`

After sign-in the client navigates to `next` if it merely starts with '/'. Protocol-relative values such as `/?next=//evil.example` (and `/\evil.example`, which the URL parser normalises to a host) pass that check; router.push() resolves them against the page origin, sees a foreign origin and performs a hard navigation, so a link that legitimately points at the real sign-in page ends on an attacker site immediately after the user has typed their password. Classic phishing chain ('session expired, sign in again'), and it composes with SEC-2.

Evidence:

```
src/components/AuthForm.tsx:32-33 `const next = params.get("next"); router.push(next && next.startsWith("/") ? next : mode === "signup" ? "/connect" : "/feed");`
```

**Recommendation.** Validate as a same-origin path: `function safeNext(v: string | null): string | null { if (!v || !v.startsWith("/") || /^\/[\/\\]/.test(v)) return null; try { return new URL(v, location.origin).origin === location.origin ? v : null; } catch { return null; } }`, or restrict to an allow-list of the four app routes since only /feed, /connect, /saved and /settings are ever generated.

### SEC-5 · Web Push endpoints are user-supplied URLs the server POSTs to with no network guard (blind SSRF)

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `src/lib/push.ts:43`

isValidSubscription() accepts any https:// URL up to 2000 chars; the daily notify cron then makes the server POST to it via web-push. The README frames the Bluesky PDS as 'the one destination a user chooses', but push endpoints are a second one, and net-guard is not applied. A user can register up to 20 endpoints such as https://10.0.0.5:8443/admin or https://localhost:3000/anything and have the server hit them every day; the request body is encrypted so the payload is not attacker-controlled, but this still reaches internal HTTPS services, and whether the subscription is subsequently removed (404/410) versus kept is observable through GET /api/push/subscribe, giving a per-host status oracle. Impact is bounded (blind, POST-only, once per day per endpoint), hence low.

Evidence:

```
src/lib/push.ts:42-47 `typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length <= 2000` | src/lib/push.ts:114 `await webpush.sendNotification(toWebPush(row), payload, { TTL: 60 * 50 });` | src/lib/push.ts:118-121 `if (status === 404 || status === 410) { removeSubscription(row.endpoint);`
```

**Recommendation.** In the subscribe route, run `await assertPublicHost(new URL(sub.endpoint).hostname)` before saving, and optionally restrict to known push-service hosts (fcm.googleapis.com, updates.push.services.mozilla.com, *.notify.windows.com, web.push.apple.com, and their regional variants) with an env override for others. Stop exposing removal as an oracle by returning subscriptions without differentiating removed-by-push-service from never-existed, or simply not listing endpoints.

### SEC-6 · Session bearer tokens stored in plaintext in the database

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `src/lib/session.ts:11`

The raw 32-byte session token that the browser presents is stored as the sessions.token primary key. Anyone who can read daily-scroll.db (a leaked backup, a world-readable DATA_DIR on a shared host, a future SQL/file-read bug, or SEC-1 aimed at an internal file service) can impersonate every user for up to 30 days without touching password hashes. The description in the task ('sessions signed with SESSION_SECRET') does not match the implementation: tokens are opaque random values, which is fine, but they should be stored hashed like passwords are. The data directory is also created with default permissions.

Evidence:

```
src/lib/session.ts:9-13 `const token = randomToken(32); ... "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, now(), now() + SESSION_TTL_MS);` | src/lib/db.ts:57-58 `CREATE TABLE IF NOT EXISTS sessions ( token TEXT PRIMARY KEY,` | src/lib/db.ts:143 `fs.mkdirSync(dataDir, { recursive: true });`
```

**Recommendation.** As written, plus: the same hashing must be applied at src/lib/auth.ts:86 and :95, where changePassword() and revokeOtherSessions() compare `token != ?` against the cookie value from currentSessionToken() - miss either and a password change would sign the user out of the device doing the changing. Also fix .env.example:3 and src/instrumentation.ts:15, which both claim sessions are signed.

### SEC-7 · No security headers: no CSP, no frame-ancestors/X-Frame-Options, no Referrer-Policy or HSTS, X-Powered-By left on

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `next.config.ts:3`

next.config.ts sets only reactStrictMode, so the app ships with no Content-Security-Policy, can be framed by any origin, and advertises X-Powered-By: Next.js. Clickjacking is practical here: the Settings page has single-click buttons for 'Sign out other devices', 'Disconnect', theme changes and 'Delete my account' toggle (deletion itself is protected by the typed-email confirmation). Thumbnails and videos are loaded from arbitrary platform CDNs (and from a user-chosen Bluesky PDS in the case of thumbnailUrl), and although no XSS sink was found, a CSP would be the only backstop if one appears.

Evidence:

```
next.config.ts:3-5 `const nextConfig: NextConfig = { reactStrictMode: true, };` | src/components/ScrollView.tsx:96-106 `<video ... src={item.videoUrl} poster={item.thumbnailUrl ?? undefined}` / `<img src={item.thumbnailUrl}` | src/lib/providers/bluesky.ts:166 `thumbnailUrl: video.thumbnail ?? null,` (PDS-supplied URL)
```

**Recommendation.** Add `poweredByHeader: false` and a `headers()` entry in next.config.ts for `/(.*)`: `Content-Security-Policy: default-src 'self'; img-src https: data:; media-src https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security: max-age=31536000` (only when served over TLS). Tighten script-src with a nonce via middleware later if desired.

### SEC-8 · Internal error messages are returned verbatim to clients and persisted into feed payloads

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `src/lib/api.ts:11`

errorResponse() sends err.message for any Error with a 400 (or 401 on login). That is intended for validation errors, but the same path surfaces SQLite constraint messages (e.g. a concurrent duplicate signup), 'Unsupported state or unable to authenticate data' from decrypt(), JSON.parse failures, and provider HTTP errors including up to 200 bytes of upstream body. collectItems() also stores those provider messages in sources[].error, which is frozen into daily_feeds.items_json and returned by /api/feed and the account export. Mostly an information-disclosure and log-hygiene issue; it is the leak channel that raises SEC-1 to high.

Evidence:

```
src/lib/api.ts:9-13 `const message = err instanceof Error ? err.message : "Something went wrong"; return json({ error: message }, { status: fallbackStatus });` | src/lib/connections.ts:194 `const message = err instanceof Error ? err.message : String(err);` ... :199 `return { provider: providerId, items: [], error: message, fromCache: false };` | src/lib/providers/http.ts:24 `${body.slice(0, 200)}`
```

**Recommendation.** Introduce a `UserFacingError` (or reuse a `status` field) for the validation/business errors you want shown, and have errorResponse() log everything else with console.error and return a generic 'Something went wrong' with 500. In collectItems() store a short classified reason ('timeout', 'auth', 'http 503') instead of the raw message.

### SEC-9 · No request-body or field-length limits on the unauthenticated auth routes; login parses the body before rate limiting

**Severity:** Low · **Category:** reliability · **Effort:** trivial · **Where:** `src/app/api/auth/login/route.ts:23`

readJson() buffers an unbounded body with req.json(), and signUp()/signIn() accept emails and passwords of any length (only a minimum of 8 is enforced). Next.js route handlers impose no body limit of their own, so without a reverse proxy cap an unauthenticated client can post multi-megabyte JSON to /api/auth/login, which is parsed before the rate limiter runs, and multi-megabyte passwords are fed to scrypt. Email strings of arbitrary size are stored in the unique index. Not catastrophic, but cheap to close.

Evidence:

```
src/app/api/auth/login/route.ts:23-27 `const body = await readJson<...>(req); const email = ...; const ip = clientKey(req); const checks = [rateLimit(...)]` (parse happens first) | src/lib/auth.ts:15-21 length checks exist only for displayName and a password minimum | src/lib/api.ts:31 `return (await req.json()) as T;`
```

**Recommendation.** Content-Length is absent under chunked transfer encoding, where `Number(null) > 16_384` is false and the check passes; and `req.text()` buffers the whole body before you can measure it. Read req.body as a stream with a running byte count and abort past the cap, or state plainly in the README that a reverse-proxy client_max_body_size is required. The rest (move the IP limiter above readJson, cap email at 254 and password at a few hundred characters) is correct.

### REL-1 · Token-encryption key is derived directly from SESSION_SECRET with no key id, so rotating the secret silently bricks every connection

**Severity:** Low · **Category:** reliability · **Effort:** small · **Where:** `src/lib/crypto.ts:24`

encrypt()/decrypt() use sha256(SESSION_SECRET) as the AES key and the ciphertext carries no key version. Rotating SESSION_SECRET, which is precisely what an operator should do after a suspected leak, makes decrypt() throw for every stored access/refresh token. usableAccessToken() throws inside withBudget(), the connection stays marked 'live' in the UI, and the only symptom is an 'Unsupported state or unable to authenticate data' string in sources[].error, with no prompt to reconnect. Users get an empty feed with no explanation.

Evidence:

```
src/lib/crypto.ts:24-26 `function key(): Buffer { return crypto.createHash("sha256").update(secret()).digest(); }` | src/lib/crypto.ts:34 `return [iv, tag, enc].map((b) => b.toString("base64url")).join(".");` (no key id) | src/lib/connections.ts:132 `const token = decrypt(row.access_token);` inside the try that maps any error to a feed-level message
```

**Recommendation.** Split the roles: add TOKEN_ENCRYPTION_KEY (falling back to SESSION_SECRET for compatibility), prefix ciphertexts with a key id (`v1.` + iv.tag.enc) and support a comma-separated list of previous keys for decryption so rotation is graceful. When decrypt() fails for a connection, catch it specifically, mark the connection as needing re-authentication (e.g. set expires_at=0 and a `broken` flag surfaced by listConnections), and show 'Reconnect' in the Connections page.

### CI-1 · GitHub Actions unpinned by SHA, no permissions block, no dependency-update automation

**Severity:** Low · **Category:** ci-cd · **Effort:** trivial · **Where:** `.github/workflows/ci.yml:18`

Both workflows reference actions/checkout@v4 and actions/setup-node@v4 by mutable tag (0/4 pinned) and declare no `permissions:`, so the GITHUB_TOKEN runs with the repository default, which may be read/write. Workflows trigger on every branch push and on pull_request, so a compromised or retagged action release would run with that token. There is no Dependabot/Renovate configuration to surface future advisories in next/web-push (the audit is clean today). Three transitive dev dependencies (esbuild, fsevents, unrs-resolver) carry install scripts that run under npm ci; these are expected for vitest/eslint but worth knowing.

Evidence:

```
.github/workflows/ci.yml:18 `- uses: actions/checkout@v4` / :20 `- uses: actions/setup-node@v4` | .github/workflows/smoke.yml:17-19 same | no `permissions:` key in either workflow | package-lock.json hasInstallScript: node_modules/esbuild, node_modules/fsevents, node_modules/unrs-resolver
```

**Recommendation.** Add `permissions: contents: read` at the top of both workflows; pin actions to full commit SHAs with a version comment (e.g. `actions/checkout@<sha> # v4.2.2`); add `.github/dependabot.yml` with `package-ecosystem: npm` and `github-actions` weekly updates. Consider `npm ci --ignore-scripts` in CI since nothing first-party needs install hooks.

### MISS-2 · Nothing bounds the size of a provider response or of the items derived from it, so a hostile Bluesky PDS can inflate memory, the SQLite file and every later read of it

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `src/lib/providers/http.ts:42`

getJson() does `await res.text()` with no size cap and then JSON.parse over the whole string; the only bound is the 8s AbortSignal, so a host the user chose can deliver as much as the link carries. The items built from it are equally unbounded - bluesky.fetchItems copies record.text, author.displayName and video.thumbnail straight into MediaItem with no length check - and they are then persisted twice: JSON.stringify(items) into provider_cache (up to 100 timeline entries, kept for 6 hours) and the curated subset into daily_feeds.items_json for a day. That stored blob is re-parsed on every subsequent read: markSeen parses the three most recent feed rows on each POST /api/feed/seen, findInFeeds parses the seven most recent on each POST /api/saved, and the account export parses all of them. This is exactly the class of problem the README says was closed - 'Three write paths are bounded, because each is loaded into memory whole when a feed is built' - but the provider item pipeline itself, which is the one path fed by a host the user picked, has no bound anywhere. Any registered user can do this to the single-process, single-file server that serves everyone.

Evidence:

```
src/lib/providers/http.ts:42-44 `const text = await res.text(); if (!res.ok) throw new ProviderHttpError(provider, res.status, text); return JSON.parse(text) as T;` | src/lib/providers/bluesky.ts:158-171 `out.push({ key: `bluesky:${rkey}`, ... title: (p.record?.text ?? "").split("\n")[0] || video.alt || "Video post", creator: p.author.displayName || `@${p.author.handle}`, ... thumbnailUrl: video.thumbnail ?? null, ...})` (no length limits) | src/lib/connections.ts:188-191 `db.prepare(`INSERT INTO provider_cache (user_id, provider, items_json, fetched_at) VALUES (?, ?, ?, ?) ...`).run(userId, providerId, JSON.stringify(items), at);` | src/lib/feed.ts:90-93 `.run(userId, win.dayKey, JSON.stringify({ items, sources }), generatedAt, win.opensAt, win.closesAt);` | src/lib/feed.ts:151-156 `const feeds = db.prepare("SELECT items_json FROM daily_feeds WHERE user_id = ? ORDER BY generated_at DESC LIMIT 3").all(userId) ... JSON.parse(row.items_json)` | src/lib/library.ts:18-23 same with LIMIT 7 | README.md 'Three write paths are bounded, because each is loaded into memory whole when a feed is built'
```

**Recommendation.** Cap the response in getJson(): read req/res through the body stream with a running byte counter and abort past, say, 2 MB, rather than calling res.text(). Then normalise MediaItem on the way in - truncate title, creator, creatorHandle and alt to a couple of hundred characters and reject a thumbnailUrl/videoUrl over ~2000 characters - in one place (a sanitiseItem() applied in collectItems, so it covers all eleven providers, not just Bluesky). A cheap belt-and-braces addition is to refuse to write a provider_cache or daily_feeds row whose serialised JSON exceeds a fixed ceiling.

### MISS-3 · First-of-the-hour feed generation has no rate limit and no single-flight guard, so concurrent requests fan out to every connected platform in parallel

**Severity:** Low · **Category:** reliability · **Effort:** small · **Where:** `src/lib/feed.ts:63`

GET /api/feed has no limiter of any kind. getFeed() only writes the daily_feeds row after collectItems() has returned, so N requests arriving before the first one finishes all see `existing === undefined` and all run the full fan-out: one outbound sequence per connected platform, each with its own PROVIDER_BUDGET_MS of 20 seconds and up to ten platforms. The provider_cache does not help, because it is written at the end of the same call. The INSERT ... ON CONFLICT DO NOTHING at the end makes the result consistent, so this is not a correctness bug, but it means one signed-in user can turn a handful of requests into a burst of outbound calls against ten third-party APIs on the operator's credentials, plus up to N x 20s of concurrent in-flight work in a single-process server. The prewarm cron mitigates it only for deployments that run it.

Evidence:

```
src/app/api/feed/route.ts:8-13 `export const GET = withUser(async (_req, user) => { purgeExpiredIfDue(); const feed = await getFeed(user.id); ... });` (no rateLimit import in the file) | src/lib/feed.ts:63-77 `const existing = db.prepare("SELECT * FROM daily_feeds WHERE user_id = ? AND day_key = ?").get(userId, win.dayKey) ... } else { const results = await collectItems(userId, at);` | src/lib/feed.ts:90-93 the insert happens only after the await | src/lib/connections.ts:166-187 `return Promise.all(rows.map(async (row) => { ... const items = await withBudget(provider.name, ..., providerBudgetMs()); ...` | src/lib/connections.ts:172-177 the cache is read before the fetch and written after it
```

**Recommendation.** Keep an in-process single-flight map keyed on `${userId}:${dayKey}`: the first caller runs collectItems and everyone else awaits the same promise. That fits the single-instance SQLite design the rate limiter already assumes, and it costs nothing when the row exists. Add a modest per-user limiter on /api/feed as a backstop.

### MISS-4 · Push subscriptions are keyed globally by endpoint and the upsert reassigns user_id, letting one account claim another's device

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `src/lib/push.ts:56`

push_subscriptions.endpoint is the primary key across all users, and saveSubscription's ON CONFLICT(endpoint) clause overwrites user_id with the caller's. Any signed-in account that learns another user's endpoint - from a shared browser profile, a copied service-worker subscription, a support log, or the GET route's own listing on a shared machine - can POST it to /api/push/subscribe and take the row over. The victim then silently stops receiving their daily notification (they can no longer even delete it: DELETE checks subscriptionsFor(user.id) and would 404) while the attacker's own 'your hour is open' push is delivered to the victim's device. The DELETE route was written with an explicit ownership check; the POST path has none, which looks like an oversight rather than a decision. Impact is bounded because the notification content is fixed and endpoints are high-entropy, so this is a cross-account integrity gap rather than a disclosure.

Evidence:

```
src/lib/db.ts:119-126 `CREATE TABLE IF NOT EXISTS push_subscriptions ( endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ...` | src/lib/push.ts:55-59 `"INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth"` | src/app/api/push/subscribe/route.ts:11-12 `if (!isValidSubscription(body.subscription)) return json(...); saveSubscription(user.id, body.subscription);` (no ownership check) | src/app/api/push/subscribe/route.ts:19-22 `// Only remove a subscription that belongs to the signed-in user. if (!subscriptionsFor(user.id).some((s) => s.endpoint === endpoint)) { return json({ error: "Unknown subscription" }, { status: 404 }); }` (the DELETE path does check)
```

**Recommendation.** Refuse the upsert when the row exists under a different user: either add `WHERE push_subscriptions.user_id = excluded.user_id` to the ON CONFLICT clause and treat zero changes as a 409, or select the row first and return 409 on a mismatch. A genuine re-registration by the same browser always carries the same user, so nothing legitimate breaks.

### MISS-5 · Outside NODE_ENV=production every OAuth token is encrypted with a hard-coded key committed to the repository, and the startup checks are skipped

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `src/lib/crypto.ts:21`

secret() returns the literal 'daily-scroll-dev-secret-change-me' whenever SESSION_SECRET is unset or shorter than 16 characters and NODE_ENV is not exactly 'production'. That string is in git, so sha256 of it is a publicly known AES-256-GCM key, and it protects the access and refresh tokens for all ten platforms. instrumentation.ts gates its SESSION_SECRET and APP_BASE_URL checks on the same NODE_ENV test, so such a deployment boots silently rather than refusing. `next start` does set NODE_ENV=production, which is why this is low rather than higher - but the failure is silent for anyone who exposes `next dev` through a tunnel for OAuth callback testing (a normal step when registering redirect URIs with ten developer portals, which the README walks through), or who runs the built server under a supervisor that clears the environment. The README and .env.example present SESSION_SECRET as required 'in production' without saying what the fallback is.

Evidence:

```
src/lib/crypto.ts:15-22 `function secret(): string { const s = process.env.SESSION_SECRET; if (s && s.length >= 16) return s; if (process.env.NODE_ENV === "production") { throw new Error("SESSION_SECRET must be set (>= 16 chars) in production"); } return "daily-scroll-dev-secret-change-me"; }` | src/lib/crypto.ts:24-26 `function key(): Buffer { return crypto.createHash("sha256").update(secret()).digest(); }` | src/lib/connections.ts:97-98 `encrypt(tokens.accessToken), tokens.refreshToken ? encrypt(tokens.refreshToken) : null,` | src/instrumentation.ts:14-20 `if (process.env.NODE_ENV === "production") { if (!secret) problems.push(...); else if (secret.length < 16) problems.push(...); ... }`
```

**Recommendation.** Tie the fallback to something narrower than NODE_ENV: allow it only when no connection row has ever been written with a real token, or gate it behind an explicit DEV_INSECURE_SECRET=1, and log a loud warning on every boot that uses it. Better still, have instrumentation.ts run its SESSION_SECRET check unconditionally and only downgrade the failure to a warning when NODE_ENV === 'development', so a tunnelled dev server that stores real platform tokens says so.

### SEC-10 · scrypt uses Node's default cost (N=16384), below current OWASP guidance

**Severity:** Info · **Category:** security · **Effort:** small · **Where:** `src/lib/crypto.ts:58`

hashPassword() calls scrypt with only a key length, so Node's defaults apply (N=2^14, r=8, p=1). OWASP's Password Storage Cheat Sheet recommends N=2^17, r=8, p=1 for scrypt. The current setting is not broken and the README's 50-150 ms measurement reflects it, but offline cracking of a leaked hash is roughly 8x cheaper than the recommended tuning. Raising N also raises memory (128 MiB per hash) and needs `maxmem`.

Evidence:

```
src/lib/crypto.ts:58 `const hash = await scryptAsync(password, salt, 64);` | src/lib/crypto.ts:67 `const actual = await scryptAsync(password, Buffer.from(saltB, "base64url"), expected.length);`
```

**Recommendation.** Correct in substance, with two mechanical notes: the promisified wrapper at crypto.ts:9-13 is typed as (password, salt, keylen) => Promise<Buffer> and must be widened to the four-argument overload before options can be passed at all; and moving to `scrypt$N$r$p$salt$hash` changes the field count, so verifyPassword's `stored.split("$")` destructuring has to branch on length to keep verifying the three-field hashes already in the database. Also remember decoyHash() (crypto.ts:78-81) pays the new cost on every sign-in for an unknown address.

### SEC-11 · CRON_SECRET compared with a plain string equality

**Severity:** Info · **Category:** security · **Effort:** trivial · **Where:** `src/app/api/cron/notify/route.ts:16`

Both cron routes compare the Authorization header to `Bearer ${secret}` with `!==`. A remote timing attack against a V8 string comparison over HTTP is not practical, so this is hygiene rather than a reachable flaw, but constant-time comparison is a one-liner and removes the question.

Evidence:

```
src/app/api/cron/notify/route.ts:16 `if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {` | src/app/api/cron/prewarm/route.ts:18 `if (auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, { status: 401 });`
```

**Recommendation.** timingSafeEqual throws when the two buffers differ in length, so the length check must short-circuit before it - `a.length === b.length && crypto.timingSafeEqual(a, b)` as written is correct, but a helper that hashes both sides first (sha256 each, then compare fixed-width digests) avoids leaking the secret's length through the early return.

## Upgrades

| Value | Effort | Upgrade | Now | Move to |
|---|---|---|---|---|
| high | small | Security response headers | No headers() in next.config.ts and no middleware/proxy: no CSP, Referrer-Policy, X-Content-Type-Options, Permissions-Policy or HSTS. Slides load <img>/<video> from arbitrary platform CDNs (ScrollView.tsx:96-106) and every clip opens a third-party site | Add headers() returning, for all routes: Content-Security-Policy with default-src 'self'; img-src 'self' https: data:; media-src https:; frame-ancestors 'none'; connect-src 'self' (script-src needs Next's nonce or 'unsafe-inline' for now); Referrer-Policy: strict-origin-when-cross-origin; X-Content-Type-Options: nosniff; Permissions-Policy: camera=(), microphone=(), geolocation=(); Strict-Transport-Security in production. Set frame-ancestors especially: the app is authenticated and framing is currently allowed. |
| high | trivial | Dependabot for npm and GitHub Actions | No .github/dependabot.yml or renovate.json (known) | .github/dependabot.yml with package-ecosystem npm (weekly, groups: minor-and-patch) and github-actions (weekly). Group simple-icons separately: it ships a new major every few months because removed icons are breaking, and only 11 stable brand icons are used. |
| high | trivial | LICENSE, SECURITY.md, CHANGELOG.md | No LICENSE (so the code is all-rights-reserved despite the README inviting people to run it), no SECURITY.md, no CHANGELOG; README credits Simple Icons as CC0 but never states the project's own terms | Add a LICENSE (MIT or AGPL-3.0 depending on intent for a self-hostable service); SECURITY.md that moves the README's 'Abuse resistance' threat model into a disclosure policy with contact and supported-versions; CHANGELOG.md seeded from the 15 existing commits, whose messages are already changelog quality (Keep a Changelog format). |
| high | medium | Browser e2e with Playwright and an enforced axe sweep | scripts/smoke.sh is curl-only; no browser test. README states 'An axe sweep across all pages in all three themes reports no serious violations' but no axe or Playwright code exists in the repo, so the claim is not enforced. Next 16.3.4 lists @playwright/test as an optional peer | @playwright/test + @axe-core/playwright; one spec that signs up, connects two demo platforms, sets the window to now, scrolls with j/k, saves a clip, waits for the closing overlay; and an axe spec over /, /connect, /settings, /saved and locked /feed with data-theme set to each of dark, light, wire. Run in ci.yml against the built app the way smoke.yml already boots it. |
| medium | small | ESLint 9.39.5 is marked unsupported; move to ESLint 10 | eslint ^9.39.5 (package-lock marks 9.39.5 'This version is no longer supported'); typescript-eslint 8.69 and eslint-plugin-react-hooks 7.1.1 already accept ^10; eslint-config-next 16.3.4 peers eslint >=9 | eslint ^10. Blocker: eslint-config-next's transitive eslint-plugin-jsx-a11y 6.10.2, eslint-plugin-import 2.32.0 and eslint-plugin-react 7.37.5 peer on eslint ^9 at most, so npm ci will ERESOLVE. Either add package.json overrides for those three (they run fine on 10) or wait for the next eslint-config-next release that bumps them; add the upgrade to Dependabot so it is not forgotten. |
| medium | small | Enable typescript-eslint's type-aware rule set | eslint.config.mjs spreads eslint-config-next and adds exactly one rule (@typescript-eslint/no-unused-vars); no tseslint recommended/strict/type-checked configs are enabled, so floating promises, unsafe any, misused promises etc. are unchecked | Add ...tseslint.configs.recommendedTypeChecked (or strictTypeChecked) with languageOptions.parserOptions.projectService = true and tsconfigRootDir; scope to src/** and test/**. Expect to fix fire-and-forget fetches such as SettingsForm.updatePrefs (no error handling on PUT /api/settings), Nav.logout, and SavedShelf.remove. |
| medium | small | vitest 3.2.7 to vitest 4, with coverage | vitest ^3.2.0 (3.2.7 resolved, vite 7.3.6); no @vitest/coverage-* package, no thresholds | vitest ^4 + @vitest/coverage-v8; vitest.config.ts add test.coverage { provider: 'v8', include: ['src/lib/**'], thresholds: { lines: 80 } } and a 'test:coverage' script wired into CI. The config here is trivial so the v4 migration is mechanical; test/push.test.ts's vi.mock factory and mockReset usage are compatible. |
| medium | small | Node 22 (maintenance LTS) to Node 24, and stop the three version declarations drifting | .nvmrc '22'; ci.yml/smoke.yml node-version '22'; engines >=22.13; @types/node ^22.15 (22.20.1 resolved). Node 22 entered maintenance in Oct 2025 (EOL Apr 2027); Node 24 is the active LTS | .nvmrc '24', engines >=24, @types/node ^24, and in both workflows use setup-node's node-version-file: .nvmrc instead of a literal so CI cannot diverge from .nvmrc. node:sqlite works unflagged on 24 exactly as on 22.13+. |
| medium | medium | Tighten tsconfig: noUncheckedIndexedAccess and friends | strict: true only; no noUncheckedIndexedAccess, noImplicitOverride, noFallthroughCasesInSwitch, verbatimModuleSyntax | Add noUncheckedIndexedAccess (will flag candidates[2] in window.ts:146, the PALETTES destructure in demo.ts:128, parts[] in net-guard.ts:28, m.map destructure in http.ts:68, and the ! in demo.ts:143), noImplicitOverride, noFallthroughCasesInSwitch, verbatimModuleSyntax (the code already uses import type everywhere). |
| medium | small | Add a formatter and .editorconfig | No Prettier/Biome/.editorconfig; formatting is by hand with a mix of 100-col multi-line objects and 180-col one-liners (e.g. twitch.ts:93, reddit.ts:97, pinterest.ts:90 vs the surrounding code) | Prettier 3 (printWidth 120 to match the prevailing style) or Biome; add 'format' and 'format:check' scripts, run format:check in ci.yml, and commit one formatting-only change. |
| medium | small | Turn on the React Compiler | next.config.ts has only reactStrictMode: true (already the App Router default); ScrollView.tsx carries six useCallback/useMemo wrappers and an eslint-disable for exhaustive-deps to keep re-renders down, and still re-renders every slide each second | reactCompiler: true in next.config.ts plus devDependency babel-plugin-react-compiler (Next 16.3.4 lists it as a peer). Then delete the manual memoisation and the exhaustive-deps disable at ScrollView.tsx:276. |
| medium | trivial | Pin actions to SHAs, add permissions and timeouts | actions/checkout@v4 and actions/setup-node@v4 by tag in both workflows (0/4 pinned); no top-level permissions block; no timeout-minutes; both workflows run npm ci + next build independently on every push to every branch | Pin each action to a full commit SHA with a version comment; add permissions: { contents: read } at workflow top; timeout-minutes: 15 per job; cache .next/cache via actions/cache keyed on the lockfile so next build is incremental; consider making smoke a second job in ci.yml with needs: check so a lint failure does not also burn a full build. |
| medium | small | CI: audit, coverage and format gates | ci.yml runs lint, typecheck, test, build; no npm audit, no coverage artifact, no format check | Add steps: npm audit --audit-level=high --omit=dev (currently 0 vulnerabilities, so it will stay green until it matters); npm run test:coverage with the report uploaded as an artifact; npm run format:check once a formatter exists. |
| medium | small | Versioned scrypt parameters | crypto.ts hashPassword uses Node's scrypt defaults (N=16384, r=8, p=1) and stores 'scrypt$salt$hash' with no parameters, so the cost can never be raised without breaking every stored hash | Store 'scrypt$N$r$p$salt$hash' (or a PHC string), raise N to 2^15-2^16 with an explicit maxmem, and in signIn re-hash on success when the stored parameters are below current (the README already measures 50-60 ms per hash, so there is headroom on the threadpool). |
| medium | small | HKDF-derived encryption key with a rotation path | crypto.ts key() is sha256(SESSION_SECRET) with no domain separation, no key id in the ciphertext (iv.tag.ct), and no way to rotate SESSION_SECRET without invalidating every stored provider token | Derive with crypto.hkdfSync('sha256', secret, salt, 'daily-scroll token encryption v1', 32); prefix ciphertext with a key id ('v1.'); accept SESSION_SECRET_PREVIOUS for decrypt-only and re-encrypt rows lazily in usableAccessToken. |
| medium | small | SQLite pragmas, indexes and ordered migrations | db.ts sets WAL + foreign_keys only; no busy_timeout; no indexes beyond primary keys (sessions.user_id, push_subscriptions.user_id, seen_items(user_id, seen_at), daily_feeds.closes_at are all queried unindexed); migrations are an ad-hoc ensureColumn that interpolates identifiers into SQL | PRAGMA busy_timeout = 5000 and synchronous = NORMAL alongside WAL; CREATE INDEX IF NOT EXISTS for the four columns above; replace ensureColumn with a schema_version table and an ordered array of migration functions. |
| medium | small | PWA manifest and service worker completeness | manifest.ts lacks id, scope, lang, categories, shortcuts and screenshots; the maskable icon reuses the non-maskable icon-512.png (will be cropped on Android); public/sw.js has no pushsubscriptionchange handler and no offline fallback, so an installed app opened offline shows the browser error page at start_url /feed | Add id '/', scope '/', lang 'en', shortcuts for /saved and /settings, a real maskable icon with safe-zone padding; in sw.js handle pushsubscriptionchange by re-subscribing with the stored applicationServerKey and POSTing to /api/push/subscribe, and serve a tiny cached offline.html (not the feed) for navigation requests when fetch fails. |
| medium | small | Deployment packaging: Dockerfile, standalone output, in-process scheduler | No Dockerfile/compose; README asks operators to wire two crontab lines against /api/cron/prewarm and /api/cron/notify; DATA_DIR defaults to ./data | output: 'standalone' + multi-stage Dockerfile (non-root user, DATA_DIR volume, HEALTHCHECK on /api/auth/me) and a compose file; optionally run the two cron jobs in-process from instrumentation.ts with setInterval when CRON_SECRET is unset, so a single container is a complete deployment. |
| medium | small | Accessibility: feed semantics, dialog focus, timed announcements | ScrollView.tsx: .scroll-list (line 385) is a plain div of <article>s; the closing overlay (line 436) is role=dialog aria-modal with no focus move, no trap, no aria-labelledby; the final-minute warning is a red bar with aria-hidden (line 380) and a haptic, nothing for screen readers; each slide has two tab stops (the full-bleed .slide-tap anchor at 83 and the 'Open in' button at 131) that do the same thing | role='feed' with aria-busy on the list and aria-posinset/aria-setsize on each article; on close, focus the 'See when it reopens' button and add aria-labelledby to the h2; a visually-hidden aria-live='polite' region announcing 'One minute left' when finalMinute flips; tabIndex={-1} on .slide-tap so keyboard users get one stop per slide. |
| medium | small | Structured logging and opt-in error reporting | Server-side errors are swallowed in withUser (api.ts:23) with no log line; the only console.error is the OAuth callback; no request ids; instrumentation.ts exists but only validates config | A tiny logger (pino or JSON console) with a request id from the incoming header, called from errorResponse for unexpected errors and from collectItems for provider failures; register an optional OpenTelemetry/Sentry exporter from instrumentation.ts when a DSN env var is set (off by default, matching the project's privacy stance). |
| medium | trivial | Verify or remove the simple-icons client dependency | meta.ts imports 11 icons from the simple-icons package root and is in the client bundle via PlatformLogo/ScrollView/LockedView; simple-icons ships ~3,300 icons in one index and a new major every few months | Run next build with @next/bundle-analyzer once to confirm tree-shaking; whichever way it goes, copying the 11 CC0 path strings into meta.ts and dropping the dependency is the simplest bundle-size and churn win (keep the attribution line in the README). |
| low | small | TypeScript 5.9.3 to 6.0 | typescript ^5.8.0 (5.9.3 resolved); typescript-eslint 8.69 already declares support for <6.1 | typescript ^6.0 once next typegen / eslint-config-next are confirmed happy; TS 6 is the bridge release that changes several defaults this tsconfig sets explicitly (esModuleInterop, isolatedModules), so expect only warnings. Optionally try the native tsgo preview for a much faster npm run typecheck in CI. |
| low | trivial | typedRoutes and config clean-up | next.config.ts: { reactStrictMode: true }; router.push('/feed'), redirect('/?next=/feed') and Link hrefs are untyped strings across Nav.tsx, AuthForm.tsx, ScrollView.tsx, LockedView.tsx | typedRoutes: true (stable in Next 16) and drop reactStrictMode (default). Also set output: 'standalone' once a Dockerfile exists. |
| low | medium | i18n groundwork | All copy is inline English; ScrollView.compact() hard-codes the 'en' locale while LockedView.formatLocal uses the browser locale; ~120 user-facing strings across components | Use undefined (browser) locale in compact(); extract strings into a messages module so next-intl or plain Intl plumbing can be added later without touching components. |

- **Security response headers** (high value, small, `next.config.ts`). An authenticated app that embeds remote media and links out should not leak its URL as referrer or be frameable; this is a one-file change.
- **Dependabot for npm and GitHub Actions** (high value, trivial, `.github/dependabot.yml`). The lockfile already contains one EOL package (eslint 9); automated PRs are the only way a solo maintainer keeps 512 lockfile entries current.
- **LICENSE, SECURITY.md, CHANGELOG.md** (high value, trivial, `LICENSE`). Without a LICENSE nobody can legally self-host the thing the README tells them to self-host.
- **Browser e2e with Playwright and an enforced axe sweep** (high value, medium, `.github/workflows/smoke.yml`). ScrollView.tsx is 470 lines of interaction logic (observers, keyboard, timers, dialog) with zero automated coverage, and the README makes an accessibility promise the repo cannot currently back.
- **ESLint 9.39.5 is marked unsupported; move to ESLint 10** (medium value, small, `package.json`). Running an EOL linter means no bug/security fixes and the lockfile literally warns about it on every install.
- **Enable typescript-eslint's type-aware rule set** (medium value, small, `eslint.config.mjs`). The codebase is careful but the linter is not doing the work TypeScript can hand it; no-floating-promises alone would have flagged three UI paths where a failed request is silently ignored.
- **vitest 3.2.7 to vitest 4, with coverage** (medium value, small, `vitest.config.ts`). Coverage would make visible that src/lib/feed.ts (getFeed, lastRecap) and every API route have zero direct tests despite being the product's core.
- **Node 22 (maintenance LTS) to Node 24, and stop the three version declarations drifting** (medium value, small, `.nvmrc`). Runtime, types and CI currently agree only by convention; a single source of truth plus an active-LTS runtime removes a class of surprises and gets newer V8/undici fetch fixes that the provider layer depends on.
- **Tighten tsconfig: noUncheckedIndexedAccess and friends** (medium value, medium, `tsconfig.json`). The lib layer is index-heavy (curation queues, IPv6 group arrays, formatToParts lookups); unchecked index access is the strictness flag most likely to catch a real bug here.
- **Add a formatter and .editorconfig** (medium value, small, `package.json`). A solo repo still benefits: diffs stop containing whitespace churn and future contributors (or agents) cannot introduce a second style.
- **Turn on the React Compiler** (medium value, small, `next.config.ts`). The compiler memoises Slide automatically, which is exactly the fix the per-second re-render problem needs, and removes the most fragile code in the largest component.
- **Pin actions to SHAs, add permissions and timeouts** (medium value, trivial, `.github/workflows/ci.yml`). Standard supply-chain hygiene; the duplicated builds also double CI minutes for a project that builds twice per push.
- **CI: audit, coverage and format gates** (medium value, small, `.github/workflows/ci.yml`). Turns the currently-clean audit into a guarded property instead of a point-in-time fact.
- **Versioned scrypt parameters** (medium value, small, `src/lib/crypto.ts`). Password hashing cost should be tunable over the life of a database; today the format forecloses that.
- **HKDF-derived encryption key with a rotation path** (medium value, small, `src/lib/crypto.ts`). Operators cannot currently rotate the one secret that protects every OAuth token at rest.
- **SQLite pragmas, indexes and ordered migrations** (medium value, small, `src/lib/db.ts`). The single-process design is fine, but a busy_timeout avoids SQLITE_BUSY the first time the prewarm cron and a user request overlap, and a migration ledger documents schema history for the export/import future.
- **PWA manifest and service worker completeness** (medium value, small, `public/sw.js`). Without pushsubscriptionchange the one daily notification silently stops whenever the browser rotates the endpoint, which defeats the feature's whole premise.
- **Deployment packaging: Dockerfile, standalone output, in-process scheduler** (medium value, small, `next.config.ts`). The product is self-hosted by design; today the deployment story is a README paragraph and a crontab.
- **Accessibility: feed semantics, dialog focus, timed announcements** (medium value, small, `src/components/ScrollView.tsx`). The repo already invests in contrast, reduced motion and keyboard navigation; these are the remaining gaps in the one screen users spend the hour on.
- **Structured logging and opt-in error reporting** (medium value, small, `src/lib/api.ts`). A hung platform or a corrupt token currently produces a 400 to the client and nothing anywhere else; the operator cannot see it.
- **Verify or remove the simple-icons client dependency** (medium value, trivial, `src/lib/providers/meta.ts`). Eleven constant strings do not need a dependency that generates a breaking-major Dependabot PR three times a year.
- **TypeScript 5.9.3 to 6.0** (low value, small, `package.json`). Low urgency, but staying one major behind on the compiler while everything else is current makes the eventual jump larger.
- **typedRoutes and config clean-up** (low value, trivial, `next.config.ts`). Cheap compile-time protection against a renamed route; the app has eleven internal navigation targets.
- **i18n groundwork** (low value, medium, `src/components/ScrollView.tsx`). Low priority for a personal project, but the locale inconsistency is a visible bug for non-English users today.

## Features worth adding

- **Durable show-up ledger and a 30-day calendar on the locked screen** (high value, small). Add an hour_openings(user_id, day_key, opened_at, watched_count) table written by getFeed (src/lib/feed.ts:90) the moment a feed is generated, and make streakFor (src/lib/library.ts:117) and lastRecap (src/lib/feed.ts:115) read from it instead of daily_feeds, which purgeExpired deletes after a day. Then LockedView.tsx can render a 30-dot calendar of days the hour was opened next to the existing streak chips, and the data export route can include it.
- **'I'm done' - end the hour early and lock until tomorrow** (high value, small). The end slide's 'Done for today' (ScrollView.tsx:421) is just a link to /connect; the hour stays open and the user can scroll back in. Add closed_at to daily_feeds, a POST /api/feed/close route, and have getFeed return the locked payload when closed_at is set for today's dayKey (computeWindow unchanged). The button then calls the route and plays the existing closing ritual; LockedView shows 'You closed today's hour early' with the countdown to tomorrow. This makes the product's central promise user-enforceable.
- **Inline playback where the platform gives us a stream** (high value, medium). Most slides are a poster plus 'Open in app'. bluesky.ts:167 already receives the HLS playlist URL and throws it away (videoUrl: null); keep it, add videoKind: 'mp4' | 'hls' | 'embed' to MediaItem (types.ts:30), and in Slide (ScrollView.tsx:95) play HLS natively on Safari or via hls.js elsewhere, use the YouTube IFrame embed (embed/{id}?autoplay=1&mute=1&playsinline=1) only for the active slide, and keep the mp4 path for Reddit/X/Instagram/Facebook which already return direct URLs. The sound toggle and active-only playback logic already exist.
- **Mastodon / Fediverse provider (no developer keys)** (high value, medium). Mastodon exposes the home timeline to any client and needs no app review, which fits the keyless tier Bluesky occupies. New src/lib/providers/mastodon.ts implementing SocialProvider with credentialConnect fields (instance URL, access token) or dynamic app registration via POST /api/v1/apps; fetch /api/v1/timelines/home?limit=80, keep statuses whose media_attachments include type video/gifv, use meta.original.duration for durationSeconds and preview_url for the poster. The instance host is user-chosen so it must go through assertPublicHost exactly like bluesky.ts:75 and use redirect: 'manual'. Register in providers/index.ts, add PROVIDER_META (siMastodon) and a permalinkFor case in demo.ts.
- **Account recovery via one-time recovery codes** (high value, medium). There is no password reset of any kind, so a forgotten password is a lost account. Because the app deliberately has no email infrastructure, generate eight one-time codes at sign-up and on demand in SecurityPanel.tsx, store them scrypt-hashed in a recovery_codes table, and add a 'Use a recovery code' mode to AuthForm.tsx that posts to /api/auth/recover, sets a new password, consumes the code, and revokes other sessions via revokeOtherSessions (auth.ts:92). Rate-limit it with the same per-account+IP buckets as login.
- **Per-platform short-form threshold with a user override** (medium value, small). SHORT_FORM_MAX_SECONDS = 90 in src/lib/providers/types.ts:122 is global. YouTube Shorts can be 180 s, TikTok far longer, Bluesky caps at 180 s (and reports no duration, so it always passes). Add maxShortSeconds to SocialProvider, make isShortForm consult it, and expose a 'clips up to N seconds' slider in SettingsForm.tsx stored in prefs, passed through CurationOptions into curate (curation.ts:101). The demo catalogue's 12 % long items keep exercising the filter.
- **Bluesky custom feeds and AT Protocol OAuth** (medium value, medium). bluesky.ts only reads getTimeline. Let the connect form take an optional feed URI (at://did/app.bsky.feed.generator/...) stored next to service= in the scope column, and fetch via app.bsky.feed.getFeed so users can point at a video-only feed generator. Separately, replace the app-password form with AT Protocol OAuth (@atproto/oauth-client-node) which Bluesky now recommends; the existing oauth_states table and callback route already model the dance.
- **Keyword muting ('less of this topic')** (medium value, small). Creator muting exists; topic muting does not. Add prefs.mutedWords (cap 50, lower-cased) in settings.ts, a hard filter in curate (curation.ts:99) using the existing normaliseTitle so hashtags and URLs are stripped first, a 'mute a word' input in the muted section of SavedShelf.tsx, and a long-press/secondary action on the 'Less like this' button in ScrollView.tsx offering the top nouns of the current title. Include the list in /api/account/export.
- **Named device sessions with per-device sign-out** (medium value, small). GET /api/account/sessions returns only a count. Add user_agent, last_seen_at and a created-from IP hint to the sessions table (session.ts:11), touch last_seen_at in currentUser at most every 10 minutes, return the list, and have SecurityPanel.tsx render rows like 'iPhone Safari · active 2 h ago · this device' each with its own revoke button (DELETE /api/account/sessions/:token). The password-change flow keeps its revoke-all behaviour.
- **'What's waiting' on the locked screen** (medium value, small). LockedPayload (feed.ts:31) knows only connectedCount. Add queued: Array<{provider, count, fetchedAt, error}> computed from provider_cache (and the demo count for demo rows) without revealing items, so LockedView.tsx can say '31 clips queued from 3 platforms' and, more usefully, surface a platform whose last fetch errored or whose cache is older than CACHE_TTL_MS before the hour opens to an empty feed. Prewarm already refreshes the cache 30 minutes ahead, so the number is meaningful.
- **Connection health and token-expiry warnings** (medium value, small). connections.expires_at and the last per-provider error are stored but never shown. Extend listConnections (connections.ts:58) with expiresAt, lastError and lastFetchedAt (from provider_cache / the latest daily_feeds sources), and have ConnectionsPanel.tsx show 'token expires in 3 days - reconnect' for Facebook (facebook.ts:81 has no refresh path) and Instagram/Threads long-lived tokens, plus the last error text. Pair with a 'Test connection' button that calls collectItems for one provider.
- **Weekday-specific opening times** (medium value, medium). One window_start for every day is rigid (a 21:00 weekday hour is wrong for a Sunday morning). Store windowStartByWeekday: Partial<Record<0-6, 'HH:MM'>> in prefs (settings.ts), and change computeWindow (window.ts:139) to take a start resolver per candidate day - the candidate loop already builds yesterday/today/tomorrow individually, so each can carry its own start. SettingsForm.tsx gets a compact seven-day row that defaults to the single time; cron/notify and prewarm need no changes because they call windowFor.

## Code quality

- **Streaks and the hour recap read from a table that housekeeping deletes** (high value, small, `src/lib/library.ts`). purgeExpired (feed.ts:184) deletes daily_feeds rows a day after they close; it runs from the prewarm cron and from ordinary requests hourly. streakFor (library.ts:119) counts day_key rows in daily_feeds, and lastRecap (feed.ts:117) reads the same table with a 'within two days' window. Once the sweep has run, current/longest/total can never exceed 2 and the recap window is really one day, contradicting the README's 'consecutive days you turned up'. test/library.test.ts seeds rows directly and never calls purgeExpired, so nothing catches it. Fix with a separate hour_openings table (see features) or by nulling items_json instead of deleting, and add a test 'streak survives purgeExpired'.
- **Every slide re-renders every second** (high value, small, `src/components/ScrollView.tsx`). pct and finalMinute live in ScrollView state and are set by a 1 s setInterval (lines 314-333), so all forty <Slide> children - each with an <img>/<video>, an IntersectionObserver and three closures - reconcile every second for the whole hour. Move the timebar into its own TimeBar component with its own timer, wrap Slide in React.memo (or enable the React Compiler), and replace the per-slide IntersectionObserver with one observer owned by the list that maps entry.target.dataset.index back to a key.
- **All errors become a 400 with the raw message and nothing is logged** (high value, small, `src/lib/api.ts`). errorResponse (lines 9-13) maps any thrown Error - SQLite failures, AES-GCM auth-tag failures from decrypt ('Unsupported state or unable to authenticate data'), provider HTTP bodies via ProviderHttpError - to {error: message} with status 400 and no console/log call; withUser (line 23) funnels every route through it. login/route.ts:48 additionally answers 401 for a malformed JSON body. Introduce a ClientError (or ValidationError) class with a status for expected failures, map unknown errors to 500 with a generic body and log them with the route and user id, and throw ClientError from auth.ts/settings.ts/library.ts where messages are meant for users.
- **Redirect following bypasses the network guard** (high value, trivial, `src/lib/providers/http.ts`). getJson (line 34) calls fetch with the default redirect: 'follow'. assertPublicHost (net-guard.ts:121) checks the user-chosen Bluesky host before each request, but a public host can answer 302 Location: http://169.254.169.254/... and undici follows it unguarded; the README lists DNS rebinding as the only residual risk and this is a second, easier one. Pass redirect: 'manual' (or 'error') from bluesky.ts's three call sites and treat any 3xx as a ProviderHttpError; add a test with a local redirecting http server in the style of test/resilience.test.ts:50.
- **Missing tests for the feed core, OAuth callback, refresh and DST edges** (high value, medium, `src/lib/feed.ts`). Add test/feed.test.ts: getFeed locked returns status/window/recap/streak/savedCount; open generates, freezes (second call returns the same items after mocking PROVIDERS to return different data), seenKeys limited to this window, savedKeys included; lastRecap counts only in-feed keys and returns null past the window; markSeen honours LIMIT 3 feeds. test/library.test.ts: streak survives purgeExpired (fails today). test/connections.test.ts: usableAccessToken refreshes when expires_at is within 5 min, persists a rotated refresh token, keeps the old one on null, and uses the access token as the refresh secret for Instagram/Threads. test/oauth-callback.test.ts: unknown, other-user, expired (>15 min) and wrong-provider state all yield bad-state and consume the row; error= yields denied. test/window.test.ts: America/New_York 2026-03-08 02:30 (nonexistent) and 2026-11-01 01:30 (ambiguous) and a window straddling the transition. test/http.test.ts: parseIsoDuration for PT1H, P1DT2H, PT0S and garbage; getJson on a 200 with a non-JSON body. test/open-native.test.ts (environment: jsdom): scheme set, fallback after 1400 ms, no fallback when visibilitychange fires. test/api.test.ts: errorResponse mapping once the ClientError split exists.
- **seen_items grows without bound and is loaded whole on every generation** (medium value, trivial, `src/lib/feed.ts`). getFeed (line 79) loads every seen_items key for the user into a Set on each first-request-of-the-hour, and markSeen adds up to feedSize rows per day, but purgeExpired never touches the table (README: 'items the user saw are recorded so they never come back'). Curation only considers items published in the last maxAgeDays (7), so a key older than ~8 days can never match anything. Add DELETE FROM seen_items WHERE seen_at < ? (at - 8 days) to purgeExpired, or bound the SELECT to that window.
- **Platform name and colour are defined twice and disagree** (medium value, small, `src/lib/providers/meta.ts`). Each provider file carries name/color on SocialProvider (types.ts:95-100) and meta.ts carries PROVIDER_META with name/color/wireColor/logoPath. TikTok is '#ff2d55' in tiktok.ts:50 and '#010101' in meta.ts:37; ConnectionSummary.color (connections.ts:41) is populated from the provider copy and never read by any component (PlatformLogo uses PROVIDER_META). Drop name/color from SocialProvider and have listConnections read PROVIDER_META[id], so there is one source of truth that the client can also import.
- **currentUser and getSettings run twice per page request** (medium value, trivial, `src/lib/session.ts`). layout.tsx:29-30 calls currentUser() and getSettings(); every page (feed/page.tsx:12-15, connect, saved, settings) calls currentUser() again and feed/page.tsx calls getSettings a second time on top of getFeed's own call. Wrap currentUser and getSettings in React.cache() so a request performs one session JOIN and one settings read.
- **ScrollView.tsx mixes five concerns in 470 lines** (medium value, medium, `src/components/ScrollView.tsx`). Slide rendering (27-161), seen-mark batching (237-250), keyboard navigation (287-311), the timebar ticker (314-333) and the closing overlay (435-467) share one component and one state bag. Extract Slide.tsx, useSeenBatcher(), useScrollKeys(), TimeBar and ClosingOverlay; the memoisation and exhaustive-deps disable at line 276 disappear with the split.
- **changePassword re-implements revokeOtherSessions** (low value, trivial, `src/lib/auth.ts`). Lines 85-87 duplicate the two-branch DELETE that revokeOtherSessions (lines 92-98) already wraps; call it and return its count.
- **Cron secret check duplicated and not constant-time** (low value, trivial, `src/app/api/cron/notify/route.ts`). notify/route.ts:14-18 and prewarm/route.ts:15-18 repeat the CRON_SECRET presence check and compare the Authorization header with !==. Extract requireCronSecret(req) into src/lib/api.ts using crypto.timingSafeEqual on equal-length buffers, returning the 503/401 responses, and use it from both routes.
- **Quadratic loop in lastRecap** (low value, trivial, `src/lib/feed.ts`). Lines 127-130 call watched.includes(it.key) inside the items loop (O(items x watched)) and then build the inFeed Set for the second count anyway. Make watched a Set up front; both counts become one pass.
- **Time constants are scattered and their relationships hidden** (low value, trivial, `src/lib/feed.ts`). The 15-minute OAuth state TTL appears as 15 * 60 * 1000 in connect/[provider]/start/route.ts:33, callback/route.ts:39 and feed.ts:186; the purge horizon (86_400_000, feed.ts:184), the recap window (2 * 86_400_000, feed.ts:119), push TTL (60 * 50, push.ts:114), CACHE_TTL_MS (connections.ts:9) and PURGE_INTERVAL_MS live in five files. A src/lib/limits.ts with named exports makes the recap-vs-purge contradiction obvious and gives tests one place to import from.
- **PUT /api/settings body type omits prefs** (low value, trivial, `src/app/api/settings/route.ts`). Line 8 types the body as {timezone?, windowStart?, feedSize?} but SettingsForm.updatePrefs sends {prefs: patch} and saveSettings accepts it; the annotation is simply wrong and a future refactor that spreads only the typed keys would silently drop preferences. Type it as Parameters<typeof saveSettings>[1] or validate with a schema.
- **pushConfigured() is a predicate with a side effect** (low value, trivial, `src/lib/push.ts`). Lines 30-36 call webpush.setVapidDetails on every invocation, including once per user inside the cron/notify loop and from route handlers. Configure once (module init or instrumentation.ts, which already validates the key pair) and make pushConfigured pure.
- **Concurrent first requests can return different feeds for the same hour** (low value, trivial, `src/lib/feed.ts`). Lines 63-94: two devices hitting /api/feed at the top of the hour both run collectItems and curate; ON CONFLICT DO NOTHING keeps one row, but the loser returns the list it computed (different at, possibly different seen set), so the two devices can disagree for the whole hour. After the INSERT, re-SELECT the row and return its items, or run the read-generate-insert inside a transaction.
- **Twitch reads its client id from process.env inside fetchItems** (low value, small, `src/lib/providers/twitch.ts`). Line 97 reads process.env.TWITCH_CLIENT_ID directly because fetchItems(accessToken, providerUserId, scope) has no credentials parameter, bypassing credentialsFor and making the provider untestable without env mutation. Extend the SocialProvider.fetchItems signature with creds (null for credential/demo providers) and pass it from collectItems (connections.ts:184).
- **Small dead or stale bits** (low value, trivial, `src/components/LockedView.tsx`). LockedView.tsx:37 const [state] = useState(initial) never updates - use the prop. NotificationSetting.tsx fetches /api/push/key in both refresh() and enable(); keep the key from the first call. page.tsx:20 hero copy still says 'TikTok, Instagram, YouTube and X' while ten platforms are supported. demo.ts:178 seeds on the UTC date while getFeed keys on the user's local dayKey; pass dayKey down so the demo catalogue and the frozen feed agree on what 'today' is.
- **No response or request body size limits** (low value, small, `src/lib/providers/http.ts`). getJson (line 42) calls res.text() on whatever a platform returns, and readJson (api.ts:29) parses any request body; feed/seen/route.ts slices to 200 keys only after parsing an arbitrarily large array. Reject provider responses over a few MB (check Content-Length or read with a capped stream) and request bodies over ~64 KB before JSON.parse.

## Shared across all Platteration repositories

The same gaps recur in every repository; fixing them once as a template and copying it is cheaper than fixing them fourteen times.

### CI and supply chain

1. **No workflow sets `permissions:`** (except the two Pages deploy jobs). Add `permissions: { contents: read }` at the top of every workflow so the `GITHUB_TOKEN` handed to third-party actions cannot write to the repository.
2. **No action is pinned to a commit SHA** (0 of 50 `uses:` lines across the fourteen repositories). `actions/checkout@v4` follows a movable tag; pin to the full 40-character SHA with the version in a comment, and let Dependabot bump it.
3. **No repository has Dependabot or Renovate.** Add `.github/dependabot.yml` with `npm` (or `pip`) and `github-actions` ecosystems, weekly.
4. **No CI step runs `npm audit`** (two workflows pass `--no-audit` explicitly). Add `npm audit --audit-level=high` after `npm ci`; for the Expo apps the current transitive advisories are build-time only (`uuid` via `xcode` via `@expo/config-plugins`), so gate on `high` rather than `moderate` until Expo ships the fix.
5. **`tvsham` runs `npm ci || npm install` in CI and in its Dockerfile.** The fallback silently discards the lockfile guarantee; drop it and fix the lockfile instead.
6. **`selfreportle`, `simplacad` and `phonogeometry` have no lockfile** and install Playwright ad hoc in CI. Add a `package-lock.json` (even with devDependencies only) and use `npm ci`.
7. **Enable secret scanning and push protection** in each repository's settings; nothing is committed today, and this keeps it that way.

### Repository hygiene

8. **Ten repositories have no `LICENSE`** (battleshiple, collectcollect, drawdraw, multidcheckers, multidconnect4, notenote, randostats, selfreportle, simplacad, tvsham). Without one, nobody else may legally use or contribute to the code. The siblings that have one use MIT.
9. **Only `simplacad` has a `SECURITY.md`.** Copy it to the others with a private reporting address.
10. **No repository has a `main` branch.** In all fourteen the default branch is the original `claude/...` feature branch, so branch protection, Dependabot targets and the two GitHub Pages workflows (`abientnoiser`, `chesscheatser` both trigger on `main`/`master`) all point at a branch that does not exist; those deploys have never run. Create `main` from the current branch, make it the default, and protect it.
11. **`drawdraw` is the one repository still on Expo SDK 53** (the rest are on 57). Its eight high-severity `npm audit` findings (`image-size`, `metro`) disappear with the SDK upgrade; it is also the only app not written in TypeScript and the only one pinned to Node 20 in CI.
12. **`multidcheckers` and `multidconnect4` are near-identical copies** (same branch name, same 65-file layout, same dependencies). The timeline/multiverse engine, persistence and share code should live in one shared package so fixes land in both.

### A hardened workflow to copy

```yaml
name: CI
on:
  push:
    branches: ["**"]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<full-sha> # v4
      - uses: actions/setup-node@<full-sha> # v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint --if-present
      - run: npm run typecheck --if-present
      - run: npm test
```
