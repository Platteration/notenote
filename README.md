# The Daily Scroll

One curated hour of short-form video from the social accounts you connect. Then it's gone.

The Daily Scroll pulls clips from TikTok, Instagram, YouTube, X, Facebook, Threads, Reddit,
Pinterest and Twitch, merges them into a single balanced feed, and opens that feed for
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
| Twitch    | Recent clips from channels you follow           | Helix (`channels/followed`, `clips`)       |
| TikTok    | Your own recent published videos                | Display API (`video.list`)                 |
| Instagram | Reels from your own account                     | Instagram API with Instagram Login         |
| Facebook  | Reels and videos from your own profile          | Graph API (`me/videos`, needs App Review)  |
| Threads   | Video posts from your own account               | Threads API (`me/threads`)                 |
| Pinterest | Video pins from your own account                | Pinterest API v5 (`pins`)                  |
| Snapchat  | Spotlight has no third-party API                | Demo catalogue only                        |

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

## API

| Method | Path                               | Purpose                                              |
|--------|------------------------------------|------------------------------------------------------|
| POST   | `/api/auth/signup`, `/login`, `/logout` | Local accounts (scrypt-hashed passwords)        |
| GET    | `/api/auth/me`                     | Current user                                         |
| GET    | `/api/connections`                 | Platform connection status                           |
| GET    | `/api/connect/:provider/start`     | Begin OAuth (or create a demo connection)            |
| GET    | `/api/connect/:provider/callback`  | OAuth redirect target                                |
| DELETE | `/api/connect/:provider`           | Disconnect                                           |
| GET    | `/api/feed`                        | Today's feed, or `423 Locked` with the next window   |
| POST   | `/api/feed/seen`                   | Record `{ keys: [...] }` as seen                     |
| GET/PUT| `/api/settings`                    | Timezone, opening time (`HH:MM`), clips per day      |

## Scripts

```bash
npm run dev         # development server
npm run build       # production build
npm start           # serve the build
npm test            # vitest: window maths + curation
npm run typecheck   # tsc --noEmit
```

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
src/lib/db.ts       SQLite schema (node:sqlite)
test/               Unit tests
```
