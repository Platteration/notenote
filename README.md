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
   encrypted (AES-256-GCM) before they touch the database and refreshed when they expire.
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
watching more.

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
passed, and sign-in throttling engages. Start the app, then `bash scripts/smoke.sh`.

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

## Abuse resistance

Sign-in and sign-up are throttled by a small in-memory fixed-window limiter
(`src/lib/rate-limit.ts`). Password guessing is limited per address, and more strictly per
account *and* address — keying the strict limit on the account alone would let anyone lock a
real user out of their own account with a handful of wrong guesses. A much looser account-wide
ceiling still catches a distributed attack. Credentials are never checked before the limit,
because scrypt is deliberately expensive and that would turn sign-in into a CPU exhaustion
vector.

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
public/sw.js        Service worker: notifications only, no caching
src/lib/db.ts       SQLite schema (node:sqlite)
test/               Unit tests
```
