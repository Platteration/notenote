# The Daily Scroll

One curated hour of short-form video from the social accounts you connect. Then it's gone.

The Daily Scroll pulls clips from TikTok, Instagram, YouTube, X, Bluesky, Facebook, Threads,
Reddit, Pinterest and Twitch, merges them into a single balanced feed, and opens that feed for
**exactly sixty minutes a day** at a time you choose. Every clip carries the logo of the
platform it came from, and tapping it opens the clip in that platform's native app.
Outside the window there is nothing to scroll: the API answers `423 Locked` and the UI shows a
countdown.

## Running it

```bash
npm ci
npm run setup             # creates .env with a random secret; keeps an existing .env
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
4. **Freeze.** The first nonempty feed inside the window is stored for the day. Empty feeds can
   recover after connecting a platform or retrying an outage. Concurrent requests return the same stored feed.
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

Demo clips are generated posters and sample metadata, not playable videos or real social posts.
They are labelled **Demo** in the scroll and the archive; opening a nonexistent post is disabled.
Live OAuth flows need your platform's credentials and approvals and must be verified with your
account. Direct playback depends on the source exposing a video URL; other live clips open on
their source platform. Web Push additionally requires VAPID keys, browser permission, and the notify job.

### Opening clips in the native app

Tapping a slide (or its **Open in …** button) hands the clip to the platform's app. On iOS and
Android the app's URL scheme is tried first (`vnd.youtube://`, `twitter://status`,
`instagram://media`, `snssdk1233://` for TikTok, `pinterest://pin`, `reddit://`, `fb://`,
`twitch://`); if nothing claims it within a moment the https permalink is loaded instead, which
the OS routes to the app through universal/app links when it is installed. On desktop the
permalink opens in a new tab. An iPad counts as iOS here even though Safari on it announces
itself as a Mac. Platforms without a dependable scheme (Threads, Snapchat) go straight to the
permalink. On a phone held sideways the text sits in its own column, so tap the clip itself.

Logos are from [Simple Icons](https://simpleicons.org) (CC0).

## The one destination a user chooses

Every platform has a fixed API host except Bluesky, where naming your own PDS is a legitimate
need — and also a way to point the server at whatever it can reach. `src/lib/net-guard.ts`
resolves the host and refuses private, loopback, link-local, carrier-grade NAT, multicast and
reserved addresses, in either IP family.

The guard parses IPv6 rather than pattern-matching it, because the URL parser rewrites
`::ffff:127.0.0.1` as `::ffff:7f00:1`; a regex looking for a dotted quad lets that straight
through. An IPv4 address that a translator or a tunnel carries inside IPv6 is judged as that IPv4
address: NAT64's `64:ff9b::/96`, SIIT's `::ffff:0:0/96` and 6to4's `2002::/16`, since on an
IPv6-only network a NAT64 gateway translates `64:ff9b::a9fe:a9fe` to `169.254.169.254` unless it
was set up to refuse private destinations. NAT64's local-use `64:ff9b:1::/48` is refused whole.
The guard runs before every request to that host, not only when the connection is made, so a name
that resolved publicly at connect time cannot be repointed later.

Checking the host that was typed is not enough on its own, because a redirect is a new
destination. `getJson` therefore follows redirects by hand (`src/lib/providers/http.ts`)
instead of letting fetch do it: every hop is resolved and vetted like the first, the chain is
bounded, and an `Authorization` header is dropped when a hop leaves the origin it was issued
for. Left to the default, one 302 from a host the user named would have reached
`169.254.169.254` or a LAN address with no check at all — and handed back the first 200 bytes
of whatever answered, through the error message the Connections page renders. Replies are also
read through a counting stream and refused past 512 KB, since a destination the user chose can
otherwise stream for the whole deadline.

A check that resolves a name and then lets the connection resolve it again is passed by DNS
rebinding: a host answering publicly to the first query and privately to the second. So the
connection's own lookup is the check. Every hop `getJson` makes, the first included, and every
push delivery opens its socket through `publicSocketLookup` (`src/lib/net-guard.ts`, with the
exchange itself in `src/lib/public-request.ts`): the name is resolved once, an answer with any
private address in it is refused, and the socket connects to the addresses that were checked, so
there is no second answer to rebind to, over plain http or https alike. An IP literal never
reaches a lookup and is checked before the socket opens. Before this, what stopped a rebound
connection was TLS, which refused it at the certificate but only after opening it to the
address and port the host picked, and a refusal of redirects to plain http, where nothing is
verified and a rebinding name behind one put a GET of the host's choosing on an internal
service. That refusal is gone: a redirect to plain http is followed again, its address checked
like any other. `test/rebinding.test.ts` stages both cases and shows no connection is opened, and
`test/push-delivery.test.ts` does the same for a push endpoint.
And `ALLOW_PRIVATE_PROVIDER_HOSTS=1` turns the guard off for operators deliberately running a
PDS on their own network — off by default, because the safe choice shouldn't require reading
the documentation.

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
Screen" installs it as a standalone app that opens straight on the scroll and follows the
device's orientation.

Phones in portrait are the reference layout. A phone on its side puts the clip on the left and
its text in a column on the right, which scrolls on its own when "Why this?" is open. Anything
wider and taller than a phone (tablets either way round, laptops, desktops, ultrawide, an
unfolded foldable) shows the scroll as a centred 9:16 stage over a blurred copy of the poster,
with up and down buttons beside it. Posters that are not tall, such as YouTube and Twitch
frames, are letterboxed over that blur rather than cropped. Every page keeps its content clear
of the notch and the home indicator on all four sides.

Inside the scroll, ↑/↓ (or j/k) move between clips, also after you have clicked a button, and
Enter opens the current one in its app. When a button or link has focus, Enter and Space press
it instead. `test/layout.test.ts` pins these rules in the stylesheet; how they look was checked
in a browser at phone, landscape, tablet, desktop and ultrawide sizes.

## Why this clip?

Every clip in the feed carries a **Why this?** chip that opens an explanation of why the
curation picked it: where it ranked on its own platform, how fresh it is, and whether a
higher-scoring clip was passed over to vary who you hear from. The bars show the two score
components the ordering actually used.

Nothing here is reconstructed after the fact. `curate()` records a `CurationReason` for each
clip **as it picks it** (`src/lib/curation.ts`), including its rank in that platform's queue at
that moment, and the reasons are frozen alongside the feed. Feeds frozen before this existed
simply have no explanation rather than a wrong one.

Two rules keep the copy honest, both enforced by tests in `test/explain.test.ts`: it only
describes numbers the scorer really used, and it never disparages a clip — one that scored
poorly is passed over in silence rather than labelled unpopular. The phrasing lives in
`src/lib/explain.ts`, a leaf module with a single type-only import so the scroll can render
explanations without pulling the database layer into the browser bundle.

## The archive, muting and streaks

The hour is a hard stop, so two things exist to keep that bearable:

- **Save** a clip during the hour and it moves to **the archive** at `/saved` (Archive in the
  nav), which is reachable at any time of day. It stores a copy of the clip's metadata, so it
  survives the feed being purged. Saves are verified against your own frozen feeds server-side.
- **Less like this** mutes a creator. Curation skips them in every future feed, and you can
  unmute from the archive.

In the archive each clip can carry a **note** (up to 2,000 characters) and be filed in
**collections** (up to 50, names up to 60 characters and unique per account whatever their
case). **Search** looks at the title, the creator and their handle, your note and the names of
the collections a clip is in, optionally within one collection. It folds case for ASCII letters
only (SQLite's `lower()`, matched with `instr` rather than `LIKE`, whose cost on a crafted note
and query was the note's length times the query's) and shows the newest 200 matches. The archive
holds up to 5,000 clips.
Saving a clip you already kept keeps its note and collections; deleting a collection keeps its
clips and their notes.

A note is your own writing and cannot be brought back, so removing a clip that has a note or
sits in a collection asks first, in the archive and from the scroll's Save button. The server
holds the same line: `DELETE /api/saved` answers `409` with `needsConfirm` for such a clip
until `confirm=1` is sent, which covers a note added in another tab or on another device. A
plain saved clip is removed straight away.

The locked screen shows a streak of consecutive days you turned up for your hour. Because the
hour is fixed, it rewards the ritual rather than the volume — there is no way to inflate it by
watching more. Turning up is recorded in its own small ledger (`hour_opens`), one row per day,
written on every request inside the window. It cannot be read off the feed rows: housekeeping
drops a feed a day after its hour closes, which silently capped every streak at two.

Visit dates are stored separately from expiring feeds, so cleanup does not erase streaks.
Existing retained feed dates are migrated automatically; dates already purged by an older
version cannot be recovered. Visit history is included in exports and removed with the account.

The export carries the archive too — each saved clip with its note, the collections and what is
filed in them — and the endpoints of your push devices, but not their keys. It never fails on one
unreadable row: a saved clip or feed whose stored copy cannot be read is listed with
`error: "unreadable"` (a clip keeps its note) and the rest goes ahead. Deleting the account
removes every row in one transaction.

## Appearance

Settings carries five themes — four core and one seasonal — eight accent palettes, a
three-state reduce-motion control (System follows the device's `prefers-reduced-motion`; On and
Off mean exactly that, whatever the device says), opt-out haptics and an opt-in chime, with a
confirmed reset to the defaults that touches nothing else.
Preferences are applied server-side, so there is no flash of the wrong theme on load. A row an
older build wrote with the boolean reduce-motion reads as On for `true` and System for `false`.
That build also silenced haptics under reduce motion, one row answering for two; they are
independent now, so a row still carrying the boolean `true` reads with Haptics off — the quiet
it actually had — and turning Haptics on is one tap in Settings.

| Theme | What it is |
|-------|------------|
| System | Follows the device between light and dark |
| Dark | Dark surfaces, full-colour platform marks |
| Light | Warm paper tones for daylight |
| Wire | Black ground, white line work, tinted accents |
| Dusk | Deep indigo, lavender text, apricot accents. The Autumn 2026 seasonal, free to everyone |

**Accent.** Under the theme row, a row of swatches picks the pair behind the brand mark, primary
buttons, switches, field focus borders and the scroll's time bar: Apricot (the default), Ember,
Gold, Lime, Mint, Sky, Violet and Rose. Each accent is four pairs, one per colour scheme, so
Wire gets a pale tint used as line work and Light a deep tone whose button text stays readable.
It is applied as `data-accent` on `<html>` the same way the theme is, omitted for the default,
and the landing and sign-in pages always use the default.

Every theme and every accent is checked against WCAG AA. `test/contrast.test.ts` computes the
real ratios from the stylesheet — flattening the translucent badge pills onto their surface the
way a browser does — and fails if any text token drops below 4.5:1, or if an accent pair fails
under any scheme: button ink on both ends of the gradient (4.5:1, which also covers the switch
thumb), the field focus border on the input surface (3:1), the pair on the card, the page and
the black scroll (3:1), and on Wire the accent as text (4.5:1). The block that System resolves
to on a light OS is parsed as its own scheme and must match the pinned Light block token for
token.

**Wire** is structural rather than a palette swap: every surface is described by its outline
instead of a fill, buttons and switches become line work, and accents are pale tints used only
where something needs telling apart. Because several brands are near-black (TikTok, X, Threads)
and would vanish on black, each platform carries a separate `wireColor` in
`src/lib/providers/meta.ts` — a legibility tint chosen for distinction, not a brand colour. A
test asserts every one of them clears a luminance floor.

Theme identity lives in `src/lib/theme.ts`, deliberately a leaf module with no imports, so
client components can read the theme list without pulling the database layer into the browser
bundle. A test enforces that.

### Adding a theme

Themes are a catalogue, so a new one each season is a two-file change:

1. Add a `:root[data-theme="<id>"]` block to `src/app/globals.css` defining every token the
   dark `:root` block defines (the Dusk block is the template — it is token-only), and, at the
   end of the Accents section, one block per entry in `ACCENT_CATALOGUE` for the new theme
   (`:root[data-theme="<id>"][data-accent="<accent>"], :root[data-theme="<id>"] [data-accent="<accent>"]`;
   copy the Apricot set as a start). The contrast test fails loudly for a missing one.
2. Add one entry to `THEME_CATALOGUE` in `src/lib/theme.ts`: `id`, `label`, `note`, `kind`
   (`core` or `seasonal`), `season` and `releasedAt` for a seasonal one, `tier`, and `badges`.

Then `npm test`. `test/contrast.test.ts` reads the catalogue and checks the new block's text and
badge tokens against its own surfaces; `test/theme.test.ts` checks the metadata; the settings
picker and the persisted preference need no change. Two conventions to know: `dark` has no block
because it *is* the `:root` defaults, and `system` has no block because it is the absence of the
attribute. The `tier` field is recorded but not enforced — nothing is gated.

### Adding an accent

1. Add five blocks to the Accents section at the end of `src/app/globals.css`, following the
   Apricot set: the base dark pair, the OS-light copy inside the `prefers-color-scheme: light`
   media query, and one block each for the pinned light, dusk and wire themes. Keep the self
   selector first on its line and the descendant selector (`… [data-accent="<id>"]`) second — the
   picker swatch relies on it.
2. Add one `{ id, label }` entry to `ACCENT_CATALOGUE` in `src/lib/accent.ts` (a leaf module
   with no imports, enforced by `test/accent.test.ts`).

Then `npm test`: the contrast test checks all five blocks against their scheme's surfaces, and
the picker and the persisted preference need no change.

## Sign in with Google and Support this app

Two things a deployment can turn on, both off until the operator supplies their keys: **Sign in
with Google** as a second way into an account, and **Support this app**, a one-time payment
through Stripe that puts a supporter badge beside the account in the navigation and changes
nothing else. With no keys (the default) `GET /api/config` answers
`{"auth":{"google":false},"shop":{"products":[]}}`, every route below answers 404, and no page
draws a Google or Buy control: the app is what it was. A half-configured feature stays off and
the server says at start which variables are missing or malformed, by name only.

They are built on the shared kit in `server/kit/` (the same files, byte for byte, in every app
of the account that carries it; never edited here), from inside this app's own stack: its
`google.js` (the authorize URL, PKCE, the code exchange and the ID-token check against Google's
keys), `stripe.js` (prices, Checkout Sessions, the webhook signature and event parsing),
`crypto.js` and `http.js`. The accounts, sessions and database stay this app's own:
`src/lib/integrations/` (configuration, the Google flow, the shop), `src/lib/google-accounts.ts`
(what a Google sign-in does to the accounts), and the routes listed under API. `npm test` runs
the kit's own self-test first.

**Sign in with Google.** A Google account is known by its subject identifier (`sub`), never by
its email address:

- A Google account linked to an account here signs in to that account.
- A Google account not linked to any makes a new account, with Google's verified address as
  its email and no password (Settings says so and offers no password change). It is charged to
  the same sign-up ceilings as the form.
- If an account here already has that address and has not linked this Google account, nothing
  is made and nothing is linked, and the sign-in page says to sign in with that account's
  password and link Google from Settings. This app sends no email, so an address typed into
  the sign-up form proves nothing about who owns it; joining the two by address would hand an
  account to whoever registered the address first (a pre-account-takeover), in either
  direction. The same rule has a cost: anyone can sign up with a person's address and a
  password first, and that person's Google sign-up is then refused for as long as that account
  exists, with a notice telling them to sign in with a password they never set. The address
  stays taken until that account is deleted, which inside the app only whoever made it can do.
- A password account links Google from Settings, signed in: the link is made only if the
  browser Google sends back is still signed in to the account that asked. One Google account
  per account, and one account per Google account.

The flow is OpenID Connect's code flow with PKCE, `scope=openid email`. Its state, nonce,
verifier and where to land travel in a ten-minute cookie, `__Host-notenote-oauth` (HttpOnly,
Secure, SameSite=Lax), signed with `SESSION_SECRET`, so a sign-in that has not finished writes
nothing to the database; the state check at the callback is what stops a login CSRF. A sign-in
ends in a new `ds_session` cookie, as a password one does, and the one the browser held before
ends. Every failure goes back to the page with a word of the app's own (`?signin=failed`,
`?link=taken`, …), never anything Google said, and the page says it once and takes it out of
the address. It is said only where `/api/config` says sign in with Google is on: anyone can
write the word into a link, and a deployment without Google takes it out and says nothing.

**Support this app.** Buy asks `POST /api/checkout`, which creates a Stripe Checkout Session
(the account id in `client_reference_id` and the metadata, an hour to pay, a fresh idempotency
key) and answers its address; the page goes there only if it is `https://checkout.stripe.com/…`.
The page never loads Stripe.js and this site never sees a card. Nothing is granted by coming
back: only Stripe's signed webhook (`POST /api/webhooks/stripe`) writes a purchase, after the
raw body (64 KB at most) has passed the `Stripe-Signature` check (five minutes either way) and
the event's live or test mode has matched the key's. Each event is applied once
(`stripe_events`, in the same transaction as what it did), so a retried or replayed delivery
changes nothing; a database failure is a 500, which Stripe retries. A paid
`checkout.session.completed` (or `async_payment_succeeded` for a delayed method) grants
`supporter` to the account its metadata names, if that account still exists; a full refund or a
dispute takes it back, and one that arrives before the purchase is remembered so the purchase
grants nothing. After Checkout the page asks `/api/auth/me` up to five times over fifteen
seconds and thanks the visitor when the webhook has landed; it asks only once `/api/config`
lists the product, so `?purchase=success` on a deployment without the shop asks nothing. A
test-mode purchase is never read under a live key. Ten checkouts an hour per account.

What leaves the server, only when a feature is on and only if the visitor uses it: Google tells
it the Google account's id and verified address; Stripe handles the payment and is told the
account id, which it keeps with the payment. The server keeps the account id, what was bought,
the payment's id and Stripe's customer id. The About card says so in a deployment that has the
feature on, and nothing about either where it is off. Export includes the Google link and the
purchase; Delete removes both (the payment itself, and the account id with it, stays with
Stripe) and the confirmation says the badge goes with the account.

The badge is a thank-you, not a lock on anything: every feature stays the same for everyone.

### Turning them on

| Variable | For | What |
|---|---|---|
| `APP_BASE_URL` | both | The public origin, already used for the platforms' redirect URIs: https, or http only on `localhost`/`127.0.0.1`, with no path. Every address the server writes for Google and Stripe comes from it, never from the request. |
| `SESSION_SECRET` | sign-in | Already required; it also signs the ten-minute sign-in cookie. |
| `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | sign-in | A Google OAuth client of type Web application whose authorised redirect URIs include `APP_BASE_URL` + `/api/auth/google/callback`. |
| `STRIPE_SECRET_KEY` | shop | Preferably a restricted key with Checkout Sessions write, Prices read and Customers write. `sk_test_`/`rk_test_` is test mode. |
| `STRIPE_WEBHOOK_SECRET` | shop | The signing secret (`whsec_…`) of the endpoint `APP_BASE_URL` + `/api/webhooks/stripe`. |
| `STRIPE_PRICE_SUPPORTER` | shop | The Price id (`price_…`) of a one-time Price on a "Support this app" product. |

The YouTube connection's client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) may be the same
Google client: give it the second redirect URI, `APP_BASE_URL` + `/api/auth/google/callback`
beside `/api/connect/youtube/callback`, and set the sign-in pair to the same values. They are
separate variables so that a deployment connecting YouTube does not find a Sign in with Google
button appear before that redirect URI is registered. Sign-in asks only for `openid email`,
which needs no verification review; YouTube's `youtube.readonly` does, and on one client the
consent screen and its review are shared.

In Stripe (test mode first, card `4242 4242 4242 4242`): the product and its one-time price;
a webhook endpoint at `APP_BASE_URL` + `/api/webhooks/stripe` subscribed to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `charge.refunded` and `charge.dispute.created` (the
kit's two subscription events are acknowledged and ignored, since nothing here is a
subscription); the restricted key. Then the same in live mode. The shop does not need Google
sign-in: every account here, password or Google, can buy.

Records live in the app's own database (`google_identities`, `purchases`, `stripe_events`), so
there is nothing else to provision: no KV namespace, no second service. Turning sign-in off
again leaves an account made with Google with no way in (it has no password, and there is no
way to set one yet).

## API

| Method | Path                               | Purpose                                              |
|--------|------------------------------------|------------------------------------------------------|
| POST   | `/api/auth/signup`, `/login`, `/logout` | Local accounts (scrypt-hashed passwords)        |
| GET    | `/api/auth/me`                     | Current user, and what its purchases grant (`entitlements`) |
| GET    | `/api/config`                      | Whether sign in with Google and the shop are on, and what is for sale |
| GET    | `/api/auth/google/start`, `/callback` | Sign in (or up) with Google; 404 while it is off  |
| POST   | `/api/account/google`              | Start linking Google to the signed-in account        |
| POST   | `/api/checkout`                    | Start paying for `{ product }`: a Stripe Checkout address |
| POST   | `/api/webhooks/stripe`             | Stripe's signed webhook: the only thing that grants a purchase |
| GET    | `/api/health`                      | `{ ok, version }` for a container or uptime check; no session, nothing else |
| GET    | `/api/connections`                 | Platform connection status                           |
| GET    | `/api/connect/:provider/start`     | Begin OAuth (or create a demo connection)            |
| GET    | `/api/connect/:provider/callback`  | OAuth redirect target                                |
| POST   | `/api/connect/:provider/credentials` | Credential-based connect (Bluesky app password)    |
| POST   | `/api/cron/prewarm`                | Pre-fetch items for upcoming hours (`CRON_SECRET`)   |
| POST   | `/api/cron/notify`                 | Send the daily "hour is open" push (`CRON_SECRET`)   |
| GET/POST/DELETE | `/api/saved`              | The archive; GET takes `q`, `collection`, `provider`; DELETE of an annotated clip needs `confirm=1` |
| PATCH  | `/api/saved/note`                  | Set or clear a clip's note                           |
| GET/POST | `/api/collections`               | List collections, or start one                       |
| PATCH/DELETE | `/api/collections/:id`       | Rename or delete a collection                        |
| POST/DELETE | `/api/collections/:id/items`  | File a saved clip in a collection, or take it out    |
| GET/POST/DELETE | `/api/muted`              | Muted creators                                       |
| GET/POST/DELETE | `/api/push/subscribe`     | Web Push subscriptions for this device               |
| GET    | `/api/push/key`                    | VAPID public key, or `configured: false`             |
| POST   | `/api/account/password`            | Change the password; signs out every other device    |
| GET/DELETE | `/api/account/sessions`        | Count signed-in devices, or sign out the others      |
| GET    | `/api/account/export`              | Everything the app holds about you, as JSON          |
| DELETE | `/api/account`                     | Delete the account and all its data                  |
| DELETE | `/api/settings/prefs`              | Reset appearance and feedback preferences to the defaults |
| DELETE | `/api/connect/:provider`           | Disconnect                                           |
| GET    | `/api/feed`                        | Today's feed, or `423 Locked` with the next window and a recap of the last hour |
| POST   | `/api/feed/seen`                   | Record `{ keys: [...] }` as seen                     |
| GET/PUT| `/api/settings`                    | Timezone, opening time (`HH:MM`), clips per day      |

## Development

```bash
npm run dev         # development server
npm run build       # production build
npm start           # serve the build
npm run lint        # eslint (flat config)
npm run typecheck   # next typegen, then tsc --noEmit, then the shared kit's JavaScript under the same options (tsconfig.kit.json)
npm test            # the shared kit's self-test (node --test server/kit/selftest.mjs), then vitest
npm run test:conventions   # the shared repository conventions (CONVENTIONS.md)
npm run check       # lint + typecheck + test + conventions: the gate before a push
npm run test:e2e    # build, serve, walk the core flow over HTTP (scripts/smoke.sh), then in Chromium (scripts/browser-walk.mjs), then sign-in and the shop (scripts/integrations-walk.mjs)
npm run test:all    # the unit suite, then the end-to-end walks
npm run smoke       # the longer portable walk (scripts/smoke.mjs) against a running server
```

`scripts/smoke.sh` walks the core flow against a running server: the feed is private, the
hour is shut by default, two demo platforms produce a balanced short-form feed, a clip saves
to the archive, a clip from someone else's feed is refused, every archive route answers (a
note, a collection renamed and deleted, filing, search, and a removal that is refused with 409
until it is confirmed), the hour locks again once it has
passed, and sign-in throttling engages. It also checks the security headers on a real response,
including that HSTS agrees with the scheme `BASE` was reached on — so point `BASE` at the
address the server itself is configured with — and that none of the repository's own files
(sources, configuration, `.git`, the build's internals) is served, by name or by a path that
climbs out of `public/` or `/_next/static`. Start the app, then `bash scripts/smoke.sh`. The
throttling step needs per-address limits, so it only asserts a 429 when the server was started
with `TRUSTED_PROXY_HOPS=1`; otherwise it checks the attempts were rejected and says so.

On Windows, run the checks from Git Bash (or put Git's `bin` directory ahead of
`System32` in this terminal's `PATH`) so `bash` does not resolve to an unconfigured WSL
launcher. Git attributes keep the checked-in scripts and pinned documents in LF form.

`npm run smoke` is a longer walk against a running server that also runs on Windows: it adds
empty-feed recovery, concurrent requests, watch history, mute persistence, theme and accent
settings (including a rejected accent), the archive while the hour is shut (a note, a
collection, search, a removal that is refused and then confirmed), export, password changes, session revocation,
sign-out/sign-in and disconnection. It creates a unique test account and removes it afterward.
Run it against a local/test instance: registration and sign-in rate limits still apply to
repeated runs. Set `BASE` to test another local port.

For a production process, run `npm run setup`, configure `.env`, then `npm run build` and
`npm start`. Keep `SESSION_SECRET` stable: changing it makes stored provider tokens unreadable.
Use a single Node process with a persistent `DATA_DIR` and HTTPS in front of the app; ephemeral
or multi-instance hosting needs a different persistence/session architecture. Set `APP_BASE_URL`
to your public HTTPS origin before registering OAuth callbacks. Back up both the database and
the encryption secret. The setup command deliberately never replaces an existing `.env`.

`scripts/browser-walk.mjs` walks the pages in Chromium (Playwright, a development dependency)
under the headers the server really sends: it signs up through the form, connects two demo
platforms, opens the hour from Settings, scrolls, asks why a clip was chosen, saves it, files it
in a new collection, changes the theme and accent, registers the notification worker, signs out
and visits an address that does not exist, reaching each page by the app's own links. It fails
on any Content-Security-Policy violation (the page's `securitypolicyviolation` events and the
browser's console reports alike), any uncaught exception or console error, any request that
leaves the origin, any response without the headers or with a policy other than the README's
block, a nonce used twice, a permission the page still has or a feature name Chromium does not
know, and caching other than what the website section below describes. Then, in fresh browsers:
without JavaScript the page must say it needs it and a form pressed must be refused, keeping what
was typed, and a page whose scripts are made to fail or to throw — after the safety net is
listening, and before it has arrived — must show the safety net's note.

`npm run test:e2e` runs both walks with nothing to set up: it builds, starts the app on a free
port with a database of its own, waits for `/api/health`, runs `scripts/smoke.sh` and then
`scripts/browser-walk.mjs` against it, and stops the server by the PID it recorded, printing the
server log if anything failed. Run either script directly, with `BASE` set, when you already
have a server up and want to walk that one. That server has no keys, as a deployment with none
has not, and both walks check that `/api/config` says so and that no page draws a Google or Buy
control. The browser walk counts the controls only once `/api/config` has answered, and also
checks that a sign-up from `/?next=/.//evil.example/` lands on `/connect`, that
`/?signin=exists` says nothing, and that `/settings?purchase=success` never asks `/api/auth/me`.

Then it starts a second server from the same build, with sign in with Google and the shop
turned on (test credentials from `scripts/e2e-fakes.mjs`) and a fake Google and a fake Stripe
loaded into its process ahead of Next (`node --import ./scripts/e2e-upstreams.mjs`): they
replace the global fetch, which is the way out to Google and Stripe that the routes are given,
and answer Google's token and key addresses and Stripe's API inside the process. The app reads
no variable that points it at another Google or Stripe; the addresses are the kit's constants.
`scripts/integrations-walk.mjs` then drives it in Chromium under the same headers and the same
failures as the browser walk: the controls hidden when `/api/config` answers 404; sign-up with
Google; Support this app through a stand-in for Stripe's Checkout page (Buy disabled while its
press is out, so a second press asks for no second Checkout), back before the webhook, the
signed webhook, the thank-you and the badge; a replayed and an unsigned webhook; a password
account linking Google and signing in with it; a Google account whose address an unlinked
account holds signing in to nothing (the notice drawn once `/api/config` has said Google is
on); a callback nobody started; deleting the account. Google's consent page and Stripe's
Checkout are reached by navigation and stood in for with `page.route`, and they are the only
places a request may leave the site for.

One GitHub Actions workflow, `ci.yml`, runs on every push, both jobs on `ubuntu-24.04`: a `check`
job (lint, typecheck, test, conventions, build, the Chromium install and then `npm run test:e2e`,
each as its own step) and an `audit` job, which runs `node .github/audit/npm-audit.mjs`, the
fleet's shared audit gate: `npm audit --omit=dev` against the lockfile, failing on every advisory
at high or above that `.github/audit/accepted.json` does not accept. This repository has no such
list, so it accepts nothing: the job fails on what `--audit-level=high` failed on, and on any
report or lockfile it cannot read.

Demo connections are created with a POST, never a link. The session cookie is `SameSite=Lax`,
which still travels on a top-level cross-site GET, so a state-changing GET would let another
site add connections to a signed-in account.

## Configuration checks

`src/instrumentation.ts` runs once at server start and refuses to boot on a misconfigured
deployment: a missing or too-short `SESSION_SECRET` in production, a relative `APP_BASE_URL`,
or only one half of the VAPID key pair. Sign in with Google and the shop do not stop it: one
that is half configured stays off, and the start prints one line naming what is missing or
malformed, never a value. Previously a bad `SESSION_SECRET` surfaced as a 500 on
whichever request first touched encryption, which is a poor way to find out.

The `SESSION_SECRET` check itself runs everywhere, not only in production, because outside it
the app falls back to a development key that is committed to this repository — a publicly known
AES key protecting the access and refresh tokens of every connected platform. `next start` sets
`NODE_ENV=production`, so the case that matters is a dev server exposed through a tunnel to
register OAuth redirect URIs, which is a normal step and holds real tokens. Production refuses
to boot; everywhere else prints a warning on every start.

## The website: headers and hosting

The app is its own web server, so it is also its own host: every response — pages, API routes,
the hashed build assets under `/_next/static`, the files in `public/` and the not-found page —
gets its headers from `src/proxy.ts`, as it is answered. There are no `_headers`, `.htaccess` or
nginx files, because a static host cannot run the app; whatever terminates HTTPS in front of it
should pass these headers through and add no policy of its own (two Content-Security-Policy
headers are both enforced, so the stricter of each pair wins and a looser copy changes nothing,
while a stricter one breaks what this one was measured to allow). `X-Powered-By` is off
(`poweredByHeader: false` in `next.config.ts`).

Two kinds of request never reach the proxy, so their answers carry none of these headers. A
`TRACE` is answered 500 by Next itself, which cannot build the fetch `Request` the proxy is handed
for a method fetch forbids, and logs a `TypeError` for each one; nothing of the request is echoed
back. Whatever Node's HTTP parser refuses (a method it does not know, such as `TRACK`, or a
malformed request line or header) is answered 400 and closed, and a `CONNECT` is closed unanswered.
No page can send any of these: fetch forbids the three methods and cannot write a malformed
request. Next's image optimizer, which answered `/_next/image` under a policy and a cache lifetime
of its own, is off (`images.unoptimized` in `next.config.ts`); the app has no `next/image`, and
that address is a 404 like any other. `scripts/smoke.sh` checks both of those last two points.

Run it on an origin of its own — a domain or a subdomain, not a path under another site: the
session cookie is `path=/`, the service worker's scope is `/`, and `'self'` in the policy is the
whole origin, so anything else served from that origin is inside all three.

What an https deployment sends on every response, `{nonce}` being fresh per response (this block
is read by the tests, so it is the policy, not a description of it):

<!-- headers:begin -->
```text
Content-Security-Policy: default-src 'none'; script-src 'self' 'nonce-{nonce}'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https: data:; media-src https:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), autoplay=(self), browsing-topics=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), interest-cohort=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), window-management=(), xr-spatial-tracking=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```
<!-- headers:end -->

HSTS and `upgrade-insecure-requests` are sent only when `APP_BASE_URL` says the deployment
answers on https. Both promise https: a browser ignores HSTS over plain http, and the upgrade,
measured on a plain-http deployment reached by a LAN address, sent every script, stylesheet and
font to `https://` on the same port, where nothing answered.

Each source in the policy was measured, not copied: `scripts/browser-walk.mjs` loads every page
of the built app in Chromium under exactly these headers and fails on any violation.

| Directive | Why |
| --- | --- |
| `default-src 'none'` | Nothing is allowed unless it is named below. |
| `script-src 'self' 'nonce-…'` | The app's own files, and an inline script only when it carries this response's nonce. The framework inlines its bootstrap and each page's data as `<script>` elements; the proxy mints a nonce per request, puts the policy on the request as well as the response, and the framework stamps the nonce on every script it writes. Every page is rendered per request already (the root layout reads the session cookie), which a nonce needs. No `'unsafe-inline'`, and no `'unsafe-eval'` outside `next dev`. |
| `style-src 'self'` and `style-src-attr 'unsafe-inline'` | The stylesheet, and `style` attributes: React writes `style` props as attributes, and the components use them for values computed per item (a reason bar's width, the countdown ring, a platform's brand colour). An injected `<style>` element, which can select and leak what a page shows, is still refused. The framework's default not-found page styles itself with one, which is why the app has its own (`src/app/not-found.tsx`). |
| `img-src 'self' https: data:`, `media-src https:` | Thumbnails and videos come from whichever CDN a connected platform uses; demo posters are inline SVG. |
| `font-src 'self'` | The display face, which `next/font` downloads at build time and serves from `/_next/static/media`. |
| `connect-src 'self'`, `worker-src 'self'`, `manifest-src 'self'` | The app's own API, the notification service worker and the web manifest. Sign in with Google and Stripe's Checkout are top-level navigations, which the policy does not govern, so neither adds a source: no Google or Stripe script, frame, font or image is loaded, and the integrations walk measures that under this header. |
| `base-uri 'none'`, `object-src 'none'` | No page sets a `<base>` or embeds a plugin. |
| `form-action 'none'` | Every form is sent by its script, so the browser itself never submits one: an injected `<form>` cannot send what is typed into it, or what a password manager fills in, anywhere. A form pressed before the page's scripts have run is refused rather than reloading the page and losing what was typed; the browser walk presses the sign-up form with scripts off and checks exactly that. |
| `frame-ancestors 'none'` (and `X-Frame-Options: DENY`) | Settings has single-click buttons for signing other devices out and disconnecting platforms, which is exactly what a clickjacking frame wants. |

Not adopted, measured: `require-trusted-types-for 'script'`. The framework's chunk loader
assigns script URLs to `script.src` as plain strings and its error screen writes CSS through
`innerHTML`, and neither creates a Trusted Types policy, so under it sign-up never reached the
Connections page.

`Permissions-Policy` denies every powerful feature the browser offers but `autoplay`, which this
origin keeps because a clip starts playing as it scrolls into view; vibration, the Web Audio
chimes and notifications are not features the header governs. The walk reads
`document.featurePolicy` and fails on a name Chromium does not recognise, since a misspelt
feature is ignored without a word. `Cross-Origin-Resource-Policy: same-origin` keeps other sites
from embedding the app's own files; `Cross-Origin-Opener-Policy: same-origin` keeps a window on
another site that the app opened, or that opened it, from holding a reference to it.

Caching is left to the framework, and the walk pins what it measured: pages and API responses
are `no-store` (every one is somebody's own), the content-hashed assets under `/_next/static`
are `public, max-age=31536000, immutable`, and `public/` files and the manifest, whose names
carry no version, are `max-age=0`, so they are revalidated on every use.

When a page's scripts fail to load, or throw before the app has started, `public/guard.js` (loaded
from its own file in every page's `<head>`) puts a note at the top of the page
saying so, with a Reload button, instead of leaving buttons that do nothing; the app tells it
when it has started (`src/components/Started.tsx`), and a browser without JavaScript gets a
`<noscript>` note instead. `public/robots.txt` keeps search engines out — every page past the
sign-in form is somebody's own feed — and `public/.well-known/security.txt` points at
`SECURITY.md` and GitHub's private vulnerability reporting. Its `Expires` date must be renewed
before it lapses: `test/site-files.test.ts` fails once it has, or once it is set more than a
year ahead.

The headers are written by `src/proxy.ts` rather than by `headers()` in `next.config.ts`. A
config `headers()` entry is evaluated once by `next build` and frozen into
`.next/routes-manifest.json`, which the production server answers from; building in CI or an
image and supplying `APP_BASE_URL` at `npm start`, the shape this README and `.env.example`
describe, would then have taken the build machine's answer — no HSTS for an https deployment,
or a year of https-only announced over plain http from an image built with an https base URL —
and could not carry a nonce at all. The policy itself is in `src/lib/security-headers.ts`, and
`test/headers.test.ts` checks what it says, that it is the block above word for word, and that
a change to the environment alone changes what is served.

## Abuse resistance

Sign-in and sign-up are throttled by a small in-memory fixed-window limiter
(`src/lib/rate-limit.ts`). Password guessing is limited per address, and more strictly per
account *and* address — a limit keyed on the account alone that *refuses* the request is an
account-lockout weapon, because a stranger who knows an address can spend it on wrong guesses
and the owner's correct password is then refused too, with no password reset in this app to
recover through. So the account-wide ceiling counts rather than refuses: past it a guess waits a
second and only a wrong one is turned away, while the account's own correct password still gets
in and empties the bucket. Only so many of those waits are held at once, and the surplus skips
the wait rather than being refused: a one-second hold on a connection the attacker chooses the
number of is a cheaper thing to spend than the guessing it was meant to slow, and refusing at
that point would be the lockout again. Credentials are never checked before the limits, because
scrypt is deliberately expensive and that would turn sign-in into a CPU exhaustion vector. A
successful sign-in also clears that account's bucket for that address, but not the shared
per-address one:
anyone with an account of their own could otherwise reset it between guesses at someone else's.

Every one of those limits is keyed on something the caller picks, so a flood that varies the
address on each request passes all of them and still pays for a scrypt each time — the decoy
hash for an unknown account is what makes sign-in indistinguishable, and also what makes each
flood request expensive. The number of passwords being verified at once is therefore bounded as
well, and that bound *queues*. Refusing at the ceiling instead was a wider version of the lockout
this section starts by avoiding, and a cheaper one: nine connections of junk sign-ins, needing no
account name and no address, refused fourteen of twenty correct passwords deployment-wide. So an
attempt past the ceiling waits for a slot for up to four seconds, and is answered 503 only when
the waiting room is full or that wait ran out. The waiting room is bounded in turn, because a
queue nobody leaves is a socket and a buffered body per caller; it is sized so that a request
admitted to it is normally served well inside the wait.

The ceiling is the same for everyone on purpose. Keeping slots back for addresses that have an
account would keep real sign-ins moving under a flood — and would also answer "is this address
registered" differently while the gate is busy, which is the question the decoy hash spends a
real scrypt per attempt not to answer. So the property this holds is narrower than "a correct
password always gets in": guessing at an account from elsewhere cannot refuse that account's own
password, while a flood aimed at the deployment slows sign-in for everybody and can refuse it
while it lasts, clearing as the hashes finish rather than at the end of a fixed window.

**Per-address limits need a reverse proxy.** A route handler cannot read the socket address, so
the only client identity available is `X-Forwarded-For` — which is whatever the client typed
unless something trustworthy rewrote it. `TRUSTED_PROXY_HOPS` (default 0) says how many proxies
do. At 0 the header is ignored and the address-keyed buckets are skipped entirely, leaving the
account-wide sign-in ceiling and a deployment-wide sign-up ceiling — which is charged for an
account that was created, not for a request that was made, or 200 posts of `{}` would close
registration for everybody for an hour at a cost of about 5 KB. "Charged for the account" still
means charged on the way in and refunded when nothing came of the request: reading the bucket on
the way in and charging it after the password hash puts the decision and the charge on opposite
sides of an await, and 260 concurrent sign-ups then created 260 accounts against a ceiling of
200. The
two failure modes this avoids are mirror images: trusting the header from a direct client gives
everyone a private bucket per request, and falling back to a shared constant gives an
unauthenticated stranger a deployment-wide sign-in lockout for twenty wrong passwords. Set
`TRUSTED_PROXY_HOPS=1` behind a single nginx or Caddy that appends to the header, and the
per-address limits come back.

The limiter's memory is bounded where its keys are the caller's to choose. Each limit keyed on an
address or an account name keeps at most 10,000 buckets, and past that forgets the least recently
used one of its own kind. The deployment-wide sign-up ceiling and the limits on a signed-in account
(current-password guesses, app-password connections) are never forgotten before their window ends.
When every limit shared one capped map, 10,000 sign-ins from fresh addresses, needing no password
check at all behind a proxy, pushed the sign-up ceiling out, and the next sign-up was accepted
inside the window that ceiling had closed.

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

Five write paths are bounded, because each is loaded into memory whole when a feed or the archive
is read, so an unbounded one is a way to make that slow and to grow shared storage. Recording a
watched clip only accepts keys that are actually in one of your own recent feeds; muting is capped
at 500 creators; the archive holds 5,000 clips and 50 collections, with notes of up to 2,000
characters; a browser handing out fresh push endpoints evicts the oldest past 20 devices rather
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
password in a change — because beyond that is not a passphrase, it is an upload. At sign-up the
length is decided before the address pattern runs, and an address past it is never matched:
the pattern backtracks quadratically over a run of dots, and one 64 KB sign-up used to hold the
server's only thread for seven seconds, `/api/health` included. Verifying a
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
answered with a plain 500. What is logged is text: where an error quotes a platform's reply (an
HTTP error's body, a reply that is not JSON, a redirect address that does not parse), its
control characters are written as escapes (`printable` in `src/lib/providers/http.ts`). For
Bluesky the host, and so the reply, is the user's choice, and a newline in it used to start a
line of the operator's log that the server never wrote, an escape sequence to reach the
terminal reading it. A platform that fails is recorded against the feed as a short
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
On Windows, where Node's chmod cannot restrict access by account, the app uses Windows
PowerShell's .NET filesystem APIs to install a protected ACL granting only the server's
current identity full control. The directory passes that policy to new children; newly
written salt files are restricted before publication too. If the volume refuses a permission
change, the app warns so the operator can arrange access controls separately, while still
persisting to a writable volume. Failure to create or read a usable salt still stops startup.
Run backup jobs under the server identity, or arrange backup access explicitly.
Unix permissions retain their existing meaning.

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

The salt file says what it is — a label and a checksum — so a file that has been edited,
truncated or half-restored is refused rather than read as a *different* salt. Decoding it and
measuring the result, which is what it used to do, is not a check at all: base64url decoding
skips every character outside its alphabet, so a hand-edited file decoded to a perfectly good
salt that was not the original one. A start that generates a new salt beside a database that
already existed says so on the console and re-keys nothing, because rewriting a stored token
under a key derived from the wrong salt is the one step here that cannot be undone — the row
stops being legacy, so putting the real salt back afterwards no longer recovers it.

**Take a copy of the database, and of the salt, before upgrading to this build.** The re-key runs
by itself the first time this version opens the database, it logs one line saying how many
connections it rewrote, and it is one-way: a build from before it cannot read what has been
rewritten. What such a build reports is `This value was encrypted with a key this deployment no
longer has. Restore the old SESSION_SECRET in PREVIOUS_SESSION_SECRETS, or reconnect the
platform.` — which is misleading here, because `SESSION_SECRET` is the one thing that is not
wrong. The way out of a rollback is to roll forward again, or to restore the copy of the database
taken before the upgrade.

A push endpoint is a URL the client chooses and the server POSTs to every day, which makes it
the second destination in the app a user picks; it goes through the same network guard as a
Bluesky PDS, so `https://10.0.0.5:8443/admin` cannot be registered and knocked on daily — and,
like the PDS, it is checked again before every send and not only when it was registered, because
a name that resolved publicly at registration can be pointed at an internal address afterwards
and the notify job runs every minute. Each delivery has ten seconds from the connection's lookup
to the status line, a deadline rather than an idle timeout, and the reply is never read
(`src/lib/push.ts`): the endpoint answers whatever its owner chooses, and web-push's own sender
read every byte of it into memory under a socket timeout that a server sending a byte at a time
never trips, so one endpoint could hold the notify job, and every user after it, for as long as it
kept sending. And a
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

Sign in with Google makes accounts too, so a new account made by it is charged to the same
sign-up ceilings as the form, the deployment-wide one always and the per-address one behind a
trusted proxy. Starting a sign-in writes nothing (its state is in a signed cookie), so an
anonymous visitor cannot grow the database by starting them. `POST /api/checkout` is limited to
ten an hour per account, keyed on the account, which a client cannot choose. The Stripe webhook
reads at most 64 KB, under the framework's 128 KB buffer, so an oversized delivery is a 413
rather than a truncated body; nothing it is sent is trusted until its signature has been checked.

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
src/lib/scroll-ui.ts  Pure decisions for the scroll (poster shape, keyboard routing); import-free
src/lib/library.ts  The archive's saved clips, muted creators, show-up streaks
src/lib/archive.ts  Notes, collections and search over the archive
src/lib/archive-limits.ts  The archive's limits (import-free, safe for client components)
src/lib/archive-client.ts  Removing a clip from the browser, asking first when it is annotated
src/lib/account-data.ts  The data export and account deletion
src/lib/integrations/  Sign in with Google and the shop: configuration, the Google flow, Stripe
src/lib/google-accounts.ts  What a Google sign-in does to the accounts (sign in, sign up, link)
src/lib/site-config.ts  What a page reads from /api/config, and the words it says about it
server/kit/         The shared sign-in, shop and webhook kit, byte for byte the canonical copy
server/catalogue.ts What the shop sells: Support this app
src/lib/push.ts     Web Push subscriptions and the one daily notification
src/lib/effects.ts  Haptics, chimes and motion preferences
src/proxy.ts        Puts the security headers, and a fresh script nonce, on every response
src/lib/security-headers.ts  The policy those headers carry
src/app/not-found.tsx  The page for an address the app does not have
src/components/Started.tsx  Tells the safety net the app has started
public/guard.js     The safety net: a note when a page's scripts fail to load or throw
public/sw.js        Service worker: notifications only, no caching
public/robots.txt, public/.well-known/security.txt  What a website serves beside its pages
src/lib/db.ts       SQLite schema (node:sqlite)
test/               Unit tests
scripts/smoke.sh    The end-to-end walk over HTTP
scripts/browser-walk.mjs  The end-to-end walk in Chromium, under the real headers
scripts/integrations-walk.mjs  Sign in with Google and the shop in Chromium, against fakes
                    loaded into the server (scripts/e2e-upstreams.mjs, scripts/e2e-fakes.mjs)
```
