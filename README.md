# The Daily Scroll

One curated hour of short-form video from the social accounts you connect. Then it's gone.

The Daily Scroll pulls clips from TikTok, Instagram, YouTube, X, Bluesky, Facebook, Threads,
Reddit, Pinterest and Twitch, merges them into a single balanced feed, and opens that feed for
**exactly sixty minutes a day** at a time you choose. Every clip carries the logo of the
platform it came from, and tapping it opens the clip in that platform's native app.
Outside the window there is nothing to scroll: the API answers `423 Locked` and the UI shows a
countdown.

## Quick start

```bash
npm install
cp .env.example .env      # optional: add platform credentials
npm run dev               # http://localhost:3000
```

Create an account, hit **Try demo** on a platform or two, then set the opening time in
**Settings** to a minute or two from now to watch the hour open and close.

Requires Node 22.13+ (the database uses the built-in `node:sqlite`, so there are no native
dependencies).

## How it works

```
connect  ->  fetch  ->  curate  ->  freeze for the day  ->  open for 60 min  ->  forget
```

1. **Connect.** Each platform is an OAuth provider under `src/lib/providers/`. Tokens are
   encrypted (AES-256-GCM) before they touch the database and refreshed when they expire. The
   key is stretched from `SESSION_SECRET` with scrypt and a per-deployment salt kept beside the
   database (`DATA_DIR/token-key.salt`), so a stolen file is not a wordlist away from every
   token in it. Each ciphertext names the key that wrote it, so `SESSION_SECRET` can be rotated
   without stranding them — see `PREVIOUS_SESSION_SECRETS` in `.env.example`.
2. **Fetch.** Every connected platform returns normalised `MediaItem`s. Results are cached for
   six hours so the platforms are not hammered; stale data is served if a platform errors.
3. **Curate** (`src/lib/curation.ts`). Short-form only (≤ 90 s), unseen, published in the last
   week. Engagement is log-scaled and normalised *within* each platform so big numbers on one
   platform can't crowd out the others, then blended with a recency decay. Cross-posts are
   deduplicated, each creator is capped, and platforms are interleaved round-robin with no
   platform allowed more than half the feed. A seed of `userId:dayKey` makes the order
   deterministic for the whole hour.
4. **Freeze.** The first request inside the window builds the feed and stores it for the day.
5. **Open for an hour** (`src/lib/window.ts`). Timezone-aware, DST-safe, and a window that
   crosses local midnight stays open until its minute is up. When the clock runs out the
   client shows "Time's up" mid-swipe.
6. **Forget.** Items the user saw are recorded so they never come back; expired feeds are purged.

## What the platforms actually expose

Third-party APIs do not hand out a platform's private "For You" feed. This is what each
provider reads, and what the demo mode stands in for:

| Platform  | Source                                          | API                                        |
|-----------|-------------------------------------------------|--------------------------------------------|
| YouTube   | Shorts from channels you subscribe to           | YouTube Data API v3 (`youtube.readonly`)   |
| X         | Short videos on your home timeline              | X API v2 reverse-chronological timeline    |
| Reddit    | Video posts on your home feed                   | Reddit API (`/best`)                       |
| Bluesky   | Video posts on your home timeline               | AT Protocol `getTimeline` (app password)   |
| Twitch    | Recent clips from channels you follow           | Helix (`channels/followed`, `clips`)       |
| TikTok    | Your own recent published videos                | Display API (`video.list`)                 |
| Instagram | Reels from your own account                     | Instagram API with Instagram Login         |
| Facebook  | Reels and videos from your own profile          | Graph API (`me/videos`, needs App Review)  |
| Threads   | Video posts from your own account               | Threads API (`me/threads`)                 |
| Pinterest | Video pins from your own account                | Pinterest API v5 (`pins`)                  |
| Snapchat  | Spotlight has no third-party API                | Demo catalogue only                        |

Bluesky needs no developer keys: users connect straight from the Connections page with an
app password (Settings → Privacy and security → App passwords in the Bluesky app). The
password is used once to open a session and is not stored.

Set the credentials for a platform in `.env` and the **Try demo** button becomes **Connect**.
Register `{APP_BASE_URL}/api/connect/<provider>/callback` as the redirect URI on each
developer portal. Any platform left unconfigured serves a deterministic, daily-changing demo
catalogue so the whole product can be explored without keys. Operators can restrict which
platforms appear at all with `ENABLED_PROVIDERS=youtube,reddit,...` (default: all).

### Opening clips in the native app

Tapping a slide (or its **Open in …** button) hands the clip to the platform's app. On iOS and
Android the app's URL scheme is tried first (`vnd.youtube://`, `twitter://status`,
`instagram://media`, `snssdk1233://` for TikTok, `pinterest://pin`, `reddit://`, `fb://`,
`twitch://`); if nothing claims it within a moment the https permalink is loaded instead, which
the OS routes to the app through universal/app links when it is installed. On desktop the
permalink opens in a new tab. Platforms without a dependable scheme (Threads, Snapchat) go
straight to the permalink.

Logos are from [Simple Icons](https://simpleicons.org) (CC0).

## The one destination a user chooses

Every platform has a fixed API host except Bluesky, where naming your own PDS is a legitimate
need — and also a way to point the server at whatever it can reach. `src/lib/net-guard.ts`
resolves the host and refuses private, loopback, link-local, carrier-grade NAT, multicast and
reserved addresses, in either IP family.

The guard parses IPv6 rather than pattern-matching it, because the URL parser rewrites
`::ffff:127.0.0.1` as `::ffff:7f00:1`; a regex looking for a dotted quad lets that straight
through. It runs before every request to that host, not only when the connection is made, so a
name that resolved publicly at connect time cannot be repointed later.

Checking the host that was typed is not enough on its own, because a redirect is a new
destination. `getJson` therefore follows redirects by hand (`src/lib/providers/http.ts`)
instead of letting fetch do it: every hop is resolved and vetted like the first, the chain is
bounded, and an `Authorization` header is dropped when a hop leaves the origin it was issued
for. Left to the default, one 302 from a host the user named would have reached
`169.254.169.254` or a LAN address with no check at all — and handed back the first 200 bytes
of whatever answered, through the error message the Connections page renders. Replies are also
read through a counting stream and refused past 512 KB, since a destination the user chose can
otherwise stream for the whole deadline.

Two limits worth stating. The check resolves the name and then fetches it, so a host answering
publicly one moment and privately the next (DNS rebinding) is not covered; closing that needs
the resolved address pinned into the connection itself. And `ALLOW_PRIVATE_PROVIDER_HOSTS=1`
turns the guard off for operators deliberately running a PDS on their own network — off by
default, because the safe choice shouldn't require reading the documentation.

## When a platform misbehaves

Feed generation waits on every connected platform, so one hung API would otherwise hold the
first request of the hour open indefinitely. Two deadlines prevent that:

- `PROVIDER_TIMEOUT_MS` (default 8s) bounds a single call.
- `PROVIDER_BUDGET_MS` (default 20s) bounds one platform's whole sequence of calls, since
  YouTube walks subscriptions, then channels, then uploads, then videos.

A platform that overruns is skipped rather than waited on. If it has cached items from an
earlier fetch those are served instead, so a stalling platform degrades to slightly stale
content rather than an empty feed, and the other platforms are unaffected.

Expired sessions, abandoned OAuth handshakes and day-old feeds are swept by `purgeExpired`,
which the pre-warm job runs on schedule and ordinary requests run at most once an hour.

## Keeping the hour instant

Fetching five platforms on the first request of the hour can take a few seconds. Set
`CRON_SECRET` and hit the pre-warm endpoint every 15 minutes; it refreshes the item cache for
anyone whose hour opens within `PREWARM_MINUTES` (default 30):

```
*/15 * * * *  curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://your.host/api/cron/prewarm
```

## One notification a day

Set VAPID keys and the notification switch in settings becomes available. The app sends
exactly one push per day, when your hour opens. There is no "you missed it", no streak
warning and no re-engagement nudge — an app about ending shouldn't spend its notification
budget dragging you back.

```bash
npx web-push generate-vapid-keys   # into VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Then run both cron endpoints, guarded by the same `CRON_SECRET`:

```
*/15 * * * *  curl -sX POST -H "Authorization: Bearer $CRON_SECRET" https://your.host/api/cron/prewarm
*   * * * *   curl -sX POST -H "Authorization: Bearer $CRON_SECRET" https://your.host/api/cron/notify
```

`notify` is idempotent per local day per device, and deletes subscriptions the push service
reports as gone. Without VAPID keys the switch simply reports push as unavailable.

## On your phone

The app ships a web manifest, icons and a notifications-only service worker, so "Add to Home
Screen" installs it as a standalone, portrait-locked app that opens straight on the scroll.
Inside the scroll, ↑/↓ (or j/k) move between clips and Enter opens the current one in its app.

## Saving, muting and streaks

The hour is a hard stop, so two things exist to keep that bearable:

- **Save** a clip during the hour and it moves to a shelf at `/saved` that is reachable at any
  time of day. The shelf stores a copy of the clip's metadata, so it survives the feed being
  purged. Saves are verified against your own frozen feeds server-side.
- **Less like this** mutes a creator. Curation skips them in every future feed, and you can
  unmute from the shelf.

The locked screen shows a streak of consecutive days you turned up for your hour. Because the
hour is fixed, it rewards the ritual rather than the volume — there is no way to inflate it by
watching more. Turning up is recorded in its own small ledger (`hour_opens`), one row per day,
written on every request inside the window. It cannot be read off the feed rows: housekeeping
drops a feed a day after its hour closes, which silently capped every streak at two.

## Appearance

Settings carries four themes, a reduce-motion switch that also honours the OS preference,
opt-out haptics and an opt-in chime. Preferences are applied server-side, so there is no flash
of the wrong theme on load.

| Theme | What it is |
|-------|------------|
| System | Follows the device between light and dark |
| Dark | Dark surfaces, full-colour platform marks |
| Light | Warm paper tones for daylight |
| Wire | Black ground, white line work, tinted accents |

Every theme is checked against WCAG AA. `test/contrast.test.ts` computes the real ratios from
the stylesheet — flattening the translucent badge pills onto their surface the way a browser
does — and fails if any text token drops below 4.5:1. An axe sweep across all pages in all
three themes reports no serious violations.

**Wire** is structural rather than a palette swap: every surface is described by its outline
instead of a fill, buttons and switches become line work, and accents are pale tints used only
where something needs telling apart. Because several brands are near-black (TikTok, X, Threads)
and would vanish on black, each platform carries a separate `wireColor` in
`src/lib/providers/meta.ts` — a legibility tint chosen for distinction, not a brand colour. A
test asserts every one of them clears a luminance floor.

Theme identity lives in `src/lib/theme.ts`, deliberately a leaf module with no imports, so
client components can read the theme list without pulling the database layer into the browser
bundle. A test enforces that.

## API

| Method | Path                               | Purpose                                              |
|--------|------------------------------------|------------------------------------------------------|
| POST   | `/api/auth/signup`, `/login`, `/logout` | Local accounts (scrypt-hashed passwords)        |
| GET    | `/api/auth/me`                     | Current user                                         |
| GET    | `/api/connections`                 | Platform connection status                           |
| GET    | `/api/connect/:provider/start`     | Begin OAuth (or create a demo connection)            |
| GET    | `/api/connect/:provider/callback`  | OAuth redirect target                                |
| POST   | `/api/connect/:provider/credentials` | Credential-based connect (Bluesky app password)    |
| POST   | `/api/cron/prewarm`                | Pre-fetch items for upcoming hours (`CRON_SECRET`)   |
| POST   | `/api/cron/notify`                 | Send the daily "hour is open" push (`CRON_SECRET`)   |
| GET/POST/DELETE | `/api/saved`              | The saved shelf                                      |
| GET/POST/DELETE | `/api/muted`              | Muted creators                                       |
| GET/POST/DELETE | `/api/push/subscribe`     | Web Push subscriptions for this device               |
| GET    | `/api/push/key`                    | VAPID public key, or `configured: false`             |
| POST   | `/api/account/password`            | Change the password; signs out every other device    |
| GET/DELETE | `/api/account/sessions`        | Count signed-in devices, or sign out the others      |
| GET    | `/api/account/export`              | Everything the app holds about you, as JSON          |
| DELETE | `/api/account`                     | Delete the account and all its data                  |
| DELETE | `/api/connect/:provider`           | Disconnect                                           |
| GET    | `/api/feed`                        | Today's feed, or `423 Locked` with the next window and a recap of the last hour |
| POST   | `/api/feed/seen`                   | Record `{ keys: [...] }` as seen                     |
| GET/PUT| `/api/settings`                    | Timezone, opening time (`HH:MM`), clips per day      |

## Scripts

```bash
npm run dev         # development server
npm run build       # production build
npm start           # serve the build
npm run lint        # eslint (flat config)
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run check       # lint + typecheck + test, what CI runs
```

`scripts/smoke.sh` walks the core flow against a running server: the feed is private, the
hour is shut by default, two demo platforms produce a balanced short-form feed, a clip saves
to the shelf, a clip from someone else's feed is refused, the hour locks again once it has
passed, and sign-in throttling engages. It also checks the security headers on a real response,
including that HSTS agrees with the scheme `BASE` was reached on — so point `BASE` at the
address the server itself is configured with. Start the app, then `bash scripts/smoke.sh`. The
throttling step needs per-address limits, so it only asserts a 429 when the server was started
with `TRUSTED_PROXY_HOPS=1`; otherwise it checks the attempts were rejected and says so.

Two GitHub Actions workflows run on every push: `ci.yml` (lint, typecheck, test, build) and
`smoke.yml` (boot the built app and run the smoke script).

Demo connections are created with a POST, never a link. The session cookie is `SameSite=Lax`,
which still travels on a top-level cross-site GET, so a state-changing GET would let another
site add connections to a signed-in account.

## Configuration checks

`src/instrumentation.ts` runs once at server start and refuses to boot on a misconfigured
deployment: a missing or too-short `SESSION_SECRET` in production, a relative `APP_BASE_URL`,
or only one half of the VAPID key pair. Previously a bad `SESSION_SECRET` surfaced as a 500 on
whichever request first touched encryption, which is a poor way to find out.

The `SESSION_SECRET` check itself runs everywhere, not only in production, because outside it
the app falls back to a development key that is committed to this repository — a publicly known
AES key protecting the access and refresh tokens of every connected platform. `next start` sets
`NODE_ENV=production`, so the case that matters is a dev server exposed through a tunnel to
register OAuth redirect URIs, which is a normal step and holds real tokens. Production refuses
to boot; everywhere else prints a warning on every start.

Responses carry a content security policy, `X-Content-Type-Options: nosniff`, a referrer policy
and `frame-ancestors 'none'` (with `X-Frame-Options` alongside it), and `X-Powered-By` is off
(`poweredByHeader: false` in `next.config.ts`). Framing is the one that earns its place today:
Settings has single-click buttons for signing other devices out and disconnecting platforms.
The policy is otherwise defence in depth — there is no `dangerouslySetInnerHTML` or `innerHTML`
anywhere in the app — and it is deliberately loose in two places: `'unsafe-inline'` for scripts,
which is what an app without a nonce needs, and any https origin for images and media, because
thumbnails and video come from whichever CDN a platform uses. HSTS is sent only when
`APP_BASE_URL` says the deployment answers on https.

The headers are written by `src/proxy.ts` as each response is answered, from the environment
of the running server — not by `headers()` in `next.config.ts`. A config `headers()` entry is
evaluated once by `next build` and frozen into `.next/routes-manifest.json`, which the
production server answers from; building in CI or an image and supplying `APP_BASE_URL` at
`npm start`, the shape this README and `.env.example` describe, would then have taken the
build machine's answer — no HSTS for an https deployment, or a year of https-only announced
over plain http from an image built with an https base URL. The policy itself is in
`src/lib/security-headers.ts`, and `test/headers.test.ts` checks both what it says and that a
change to the environment alone changes what is served.

## Abuse resistance

Sign-in and sign-up are throttled by a small in-memory fixed-window limiter
(`src/lib/rate-limit.ts`). Password guessing is limited per address, and more strictly per
account *and* address — a limit keyed on the account alone that *refuses* the request is an
account-lockout weapon, because a stranger who knows an address can spend it on wrong guesses
and the owner's correct password is then refused too, with no password reset in this app to
recover through. So the account-wide ceiling counts rather than refuses: past it a guess waits a
second and only a wrong one is turned away, while the account's own correct password still gets
in and empties the bucket. Credentials are never checked before the limits, because scrypt is
deliberately expensive and that would turn sign-in into a CPU exhaustion vector. A successful
sign-in also clears that account's bucket for that address, but not the shared per-address one:
anyone with an account of their own could otherwise reset it between guesses at someone else's.

Every one of those limits is keyed on something the caller picks, so a flood that varies the
address on each request passes all of them and still pays for a scrypt each time — the decoy
hash for an unknown account is what makes sign-in indistinguishable, and also what makes each
flood request expensive. The number of passwords being verified at once is therefore bounded as
well, and attempts past that are answered 503 rather than queued behind a four-thread pool with
everyone else's requests. A concurrency ceiling rather than another rate limit, because a
deployment-wide rate limit on sign-in would be exactly the lockout this section starts by
avoiding: this one clears as the hashes finish.

**Per-address limits need a reverse proxy.** A route handler cannot read the socket address, so
the only client identity available is `X-Forwarded-For` — which is whatever the client typed
unless something trustworthy rewrote it. `TRUSTED_PROXY_HOPS` (default 0) says how many proxies
do. At 0 the header is ignored and the address-keyed buckets are skipped entirely, leaving the
account-wide sign-in ceiling and a deployment-wide sign-up ceiling — which is charged for an
account that was created, not for a request that was made, or 200 posts of `{}` would close
registration for everybody for an hour at a cost of about 5 KB. The
two failure modes this avoids are mirror images: trusting the header from a direct client gives
everyone a private bucket per request, and falling back to a shared constant gives an
unauthenticated stranger a deployment-wide sign-in lockout for twenty wrong passwords. Set
`TRUSTED_PROXY_HOPS=1` behind a single nginx or Caddy that appends to the header, and the
per-address limits come back.

Every state-changing route refuses a request a browser made from another site
(`assertSameSite` in `src/lib/api.ts`): `Sec-Fetch-Site` decides when it is present, and an
`Origin` that disagrees with `APP_BASE_URL` is refused when it is not. `SameSite=Lax` does not
cover sign-in and sign-up, because Lax governs whether a cookie is *sent* and those routes
*set* one — so without this a cross-site `<form enctype="text/plain">`, whose body a browser
writes as `name=value` and which is therefore valid JSON when the field name carries the
prefix, could silently sign a visitor into an attacker's account and collect the platforms they
then connected. `readJson` insists on `Content-Type: application/json` as a second, independent
guard on the same hole; a form can only send three encodings and that is not one of them.

Password hashing uses scrypt through its asynchronous form. The synchronous form spends its
whole cost — 50-150ms — on the event loop, freezing every other request in the process, so a
handful of concurrent sign-in attempts would have stalled everyone's feed. Measured: five
synchronous hashes blocked a 1ms timer completely (zero ticks), where the async form let it
fire 139 times.

A sign-in for an address with no account hashes against a decoy so it costs the same as a real
one. Before that, the unknown path skipped hashing entirely and answered in 5ms against 51ms,
which told an attacker exactly which addresses were registered and made the deliberately vague
error message worthless. It is now 60ms against 57ms. A test guards the property, and fails if
the short-circuit comes back.

Sign-up, though, still answers the same question in one request: an address that already has an
account is told so ("An account with that email already exists"), and a free one gets a 201.
Closing that means sign-up answering the same way either way — with no email delivery anywhere
in this app, the person who simply mistyped their own address would be told nothing useful — so
it is a product decision rather than a patch, and it is open. Until it is made, treat the
decoy-hash timing property as protecting the sign-in endpoint specifically, not as a claim that
this deployment will not say which addresses are registered.

Four write paths are bounded, because each is loaded into memory whole when a feed is built, so
an unbounded one is a way to make that slow and to grow shared storage. Recording a watched clip
only accepts keys that are actually in one of your own recent feeds; muting is capped at 500
creators; a browser handing out fresh push endpoints evicts the oldest past 20 devices rather
than piling up; and what a platform sends is normalised on the way in (`sanitiseItems`), so a
title, creator or URL cannot be as long as the reply that carried it. That last one is applied
in `collectItems`, once, so it covers all eleven providers rather than whichever was last
audited — and it matters most for Bluesky, where the host answering is one the user picked.

Request bodies are read through a counting stream and refused past 64 KB, and `Content-Length`
cannot be the check because it is absent under chunked transfer encoding. That refusal is the
app's, and it is not the first thing a body meets: because the app emits its security headers
from `src/proxy.ts`, Next clones and buffers every request body before any handler is entered —
10 MB of it by default, on any route, including ones that never read a body. `next.config.ts`
caps that at 128 KB (`experimental.proxyClientMaxBodySize`) so the framework's ceiling and the
app's are the same number within a doubling; past its own cap the framework truncates rather
than refuses, which is what leaves the 413 to the counting stream. Sign-in also runs its
per-address limit *before* it reads the body, so a client already over the limit cannot make the
server parse anything; the account-keyed limits necessarily come after, since the account is in
the body. Email is capped
at 254 characters and a password at 256 wherever one is *written* — signing up, and the new
password in a change — because beyond that is not a passphrase, it is an upload. Verifying a
credential applies no ceiling: sign-up had no maximum until recently, so a longer one can
already be stored, and refusing it at sign-in or when proving a current password would shut
such an account for good — there is no password reset anywhere in this app.

Feed generation is single-flight per user per day. The `daily_feeds` row is only written once
every platform has answered, so several requests arriving in the seconds after an hour opens all
used to see no row and all run the whole fan-out: one outbound sequence per connected platform,
each with its own 20-second budget, on the operator's credentials. The first caller now does the
work and the rest wait on it.

Errors say as little as they can. Only a `UserFacingError` (`src/lib/errors.ts`) has its message
returned; everything else — a SQLite constraint, a JSON parse failure, a decrypt that could not
authenticate its data, a platform HTTP error carrying part of an upstream body — is logged and
answered with a plain 500. A platform that fails is recorded against the feed as a short
classified reason ("timed out", "rate limited", "needs reconnecting") rather than its message,
because that string is frozen into the feed row, returned by `/api/feed` and re-served by the
account export. Connecting a platform with an app password is the one place that says more: a
handle or password the platform refuses comes back as an HTTP 401 rather than as anything
carrying its own words, so `credentialConnectError` names that case itself ("Bluesky did not
accept those credentials") instead of leaving it indistinguishable from a blocked host or an
outage. The sentence is this app's own — the service host is the user's choice, so its wording
is never repeated back, whatever status it arrives with: a host answering `200` with an
`error`/`message` pair is refused in the same words as one answering `401`, because a status is
not what decides whether a reply can be quoted.

Session cookies are random 32-byte tokens and the database stores only their sha256. Anyone who
could read the file — a leaked backup, a world-readable `DATA_DIR` — previously held a working
cookie for every account for up to thirty days, while the passwords in the same file were behind
scrypt. Upgrading past this signs everyone out once, since the old rows hold a value that no
longer matches anything.

The file itself is made owner-only, not just the directory. `mkdir`'s mode applies only to a
directory the app creates, and the deployment shape `.env.example` recommends is one the
operator made themselves — an ordinary `mkdir`, a systemd `StateDirectory=`, a Docker volume,
all of which arrive at 0755 — while SQLite creates the database, its write-ahead log and its
shared-memory file at 0644. Each open therefore restricts the directory to 0700 and those three
files to 0600, and says so on the console if the filesystem will not have it.

The key those tokens are encrypted under is stretched rather than hashed: scrypt over
`SESSION_SECRET` with a random per-deployment salt in `DATA_DIR/token-key.salt`, derived once at
boot. It used to be a single sha256 of the secret, with a sha256 of *that* stored beside every
ciphertext to name the key — which is a free offline verifier: a 21-character secret fell to a
wordlist in 148 ms, and with it every access and refresh token in the file. A candidate now
costs what a password guess costs, the salt makes work against one install useless against
another, and the key id is an HMAC under the key rather than a hash of it. Tokens written by an
earlier version still open, and are re-keyed in place the first time this version opens the
database. **Back the salt file up with the database**: without it, tokens encrypted under it
have to be reconnected.

A push endpoint is a URL the client chooses and the server POSTs to every day, which makes it
the second destination in the app a user picks; it goes through the same network guard as a
Bluesky PDS, so `https://10.0.0.5:8443/admin` cannot be registered and knocked on daily — and,
like the PDS, it is checked again before every send and not only when it was registered, because
a name that resolved publicly at registration can be pointed at an internal address afterwards
and the notify job runs every minute. And a
subscription belongs to the account that registered it: the endpoint is the primary key across
all users, and the upsert used to reassign it, so anyone who learned someone else's endpoint
could take the row over — the victim silently stopped receiving their own notification while the
attacker's arrived on their device.

Sign-up still reports when an address is already registered, which is a deliberate trade: there
is no way to let someone create an account without telling them the address is taken. The rate
limiter bounds how fast that can be probed.

Changing a password revokes every other session, keeping only the device making the change.
Leaving other sessions live would defeat the point of a hurried password change. Settings also
shows how many devices are signed in and can sign out the rest without changing the password.

The limiter lives in process, which suits the single-instance SQLite storage. Behind several
instances it becomes per-instance and the effective limit is the sum, so a shared store or a
limit at the reverse proxy is the right answer at that point.

## Project layout

```
src/app/            Next.js App Router pages and API routes
src/components/     Client components (scroll view, countdowns, forms)
src/lib/window.ts   The one-hour window, timezone-aware
src/lib/curation.ts Scoring, dedupe, platform balancing
src/lib/feed.ts     Daily feed generation, freezing, seen tracking
src/lib/providers/  One OAuth + fetch adapter per platform, the demo catalogue, and
                    meta.ts (client-safe names, logos, native deep links)
src/lib/open-native.ts  Tap-to-open: app scheme first, permalink fallback
src/lib/library.ts  Saved shelf, muted creators, show-up streaks
src/lib/push.ts     Web Push subscriptions and the one daily notification
src/lib/effects.ts  Haptics, chimes and motion preferences
src/proxy.ts        Puts the security headers on every response as it is answered
src/lib/security-headers.ts  The policy those headers carry
public/sw.js        Service worker: notifications only, no caching
src/lib/db.ts       SQLite schema (node:sqlite)
test/               Unit tests
```
