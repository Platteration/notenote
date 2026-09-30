# notenote — security audit (2026-09-11)

A dedicated security pass, separate from and later than the review in `REVIEW.md`. Specialist reviewers read the repository through 3 independent lenses (L1, L2, L5), each required to *demonstrate* a finding rather than argue for it.

**11 findings** — 1 high, 5 medium, 5 low. Every one was reproduced with command output rather than argued from reading.

## Status

Every finding below was fixed on `claude/repo-review-security-baiyud` in 69a41a4, each with a regression test that was checked by reverting the fix and confirming the test fails. The findings are kept as written so the reasoning behind each change stays with it.

These were deliberately left for a decision rather than guessed at:

- L2-4 — sign-up still answers whether an address has an account. Closing it means answering identically either way, and with no email delivery here the person who mistyped their own address would be told nothing useful.

## Findings

### L1-1 · high — src/proxy.ts makes Next buffer up to 10 MB of every request body before any handler runs, so MAX_REQUEST_BYTES, the rate limiter and assertSameSite bound nothing

`src/proxy.ts`:22 · CWE-770 · reproduced

**Who.** Anyone who can reach the port. No account, no cookie, no same-site context, no valid Content-Type — just TCP to the app.

**How.** 1. Open a TCP connection to the app. 2. Send `POST /api/auth/login HTTP/1.1` with `Transfer-Encoding: chunked` and no terminating chunk. 3. Stream ~10 MB of chunks and then stop, leaving the request unfinished. Next has already cloned and buffered the whole body in memory because a proxy.ts exists; the route handler has not been entered, so readCappedBody's 64 KB cap, the login rate limiter and assertSameSite have not run and cannot run. 4. Repeat on N connections. Node's default requestTimeout is 300 s, so each connection pins ~9-10 MB for up to five minutes at zero cost to the attacker. A few hundred connections exhausts a typical VPS and the single-process server dies for every user.

**Why it matters.** Unauthenticated remote memory exhaustion of the whole deployment, at roughly 9 MB of server RSS per attacker connection — about 150x the 64 KB the app believes it is enforcing. Nothing in the app can refuse it, because every check lives in a route handler and the buffering happens before the handler is entered. The README's stated invariant ("Request bodies are read through a counting stream and refused past 64 KB... Sign-in also runs its per-address limit before it reads the body, so a client already over the limit cannot make the server buffer and parse anything") is false in this deployment shape.

**Evidence.**

src/proxy.ts:22-26 `export function proxy(): NextResponse { const res = NextResponse.next(); for (const { key, value } of securityHeaders(process.env)) res.headers.set(key, value); return res; }` — no matcher, so it runs for every request. node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md: "When proxy is used, Next.js automatically clones the request body and buffers it in memory to enable multiple reads - both in proxy and the underlying route handler... By default, the maximum body size is 10MB." node_modules/next/dist/server/config-shared.js:279 `proxyClientMaxBodySize: 10485760` and next.config.ts:13-17 sets only reactStrictMode and poweredByHeader, so the 10 MB default applies. src/lib/api.ts:106 `export const MAX_REQUEST_BYTES = 64 * 1024;` with the comment "A route handler gets no body limit from the framework" — which is now the opposite of what happens.

Measured against `next build && NODE_ENV=production next start` (commit b9a822f):

(a) The app's own 64 KB refusal only arrives after the entire body has been received. Sending 1.25 MB in 64 KB chunks at 200 ms intervals:
```
[1003ms] sent 0.31 MB, response so far: none
[2005ms] sent 0.63 MB, response so far: none
[3006ms] sent 0.94 MB, response so far: none
[4008ms] sent 1.25 MB, response so far: none
[4208ms] finished sending 1.25 MB
FIRST RESPONSE BYTE at 4226ms: HTTP/1.1 413 Payload Too Large
```
If readCappedBody were streaming, the 413 would have arrived at ~200 ms after 64 KB.

(b) A route that never reads a body at all behaves identically — POST /api/cron/prewarm answers 503 ("CRON_SECRET is not configured") without calling readJson, and still waits for the whole body:
```
[3206ms] finished sending 0.94 MB
[3216ms] first response byte after 0.94 MB: HTTP/1.1 503 Service Unavailable
```
So no handler-level check — auth, cron bearer, rate limit, CSRF, body cap — can prevent the buffering.

(c) The server names the limit itself. Streaming 40 MB to /api/auth/login: the 413 comes back after all 40 MB, and the server log says
```
Request body exceeded 10MB for /api/auth/login. Only the first 10MB will be available unless configured.
```

(d) Cost per attacker connection, measured on a freshly started production server (16 connections, each sending 9 MB of chunks and then going idle without the terminating chunk):
```
held 16 half-finished 9 MB uploads (terminating chunk never sent)
server RSS: 121 MB -> 267 MB  (+146 MB, 9.1 MB per idle connection)
```

This is a regression introduced by the most recent commit: `git log --oneline -- src/proxy.ts` -> `b9a822f Decide the security headers per request, not once at build`, while `git log -S readCappedBody -- src/lib/api.ts` -> `9f172e7`, the commit immediately before it.

**Fix.** Set the framework limit to something close to the app's own, in next.config.ts: `experimental: { proxyClientMaxBodySize: '128kb' }` (per the Next 16 docs, a larger body is truncated to the limit rather than rejected, so readJson's 64 KB counting stream still produces the 413 — the two now agree instead of differing by 160x). Add a test that asserts a 1 MB chunked POST to /api/auth/login is answered without the server's RSS moving by megabytes, so a future change to next.config or proxy.ts cannot silently reopen it. Also correct the README's 'Abuse resistance' paragraph and the comment at src/lib/api.ts:99-105, both of which now state the opposite of what the framework does. If bodies must not be buffered at all, the alternative is to move the header logic out of proxy.ts, but that reintroduces the build-time-HSTS problem b9a822f fixed, so configuring the limit is the right trade.


### L1-2 · medium — Unbounded Intl.DateTimeFormat cache keyed on the user-supplied timezone string: one 120-byte settings write permanently retains ~28 KB of server memory

`src/lib/window.ts`:36 · CWE-770 · reproduced

**Who.** Any signed-in account. Registration is open, so this is anyone who can reach the port plus one signup.

**How.** 1. Create an account (or use an existing one). 2. Loop `PUT /api/settings` with `{"timezone": "<spelling>"}` where each spelling is a different case permutation of one real IANA zone — `America/Argentina/Buenos_Aires` has 24 letters, so 2^24 spellings, and `Intl` accepts all of them. `isValidTimeZone` (window.ts:95) therefore accepts each one, `saveSettings` stores the raw string (settings.ts:65), and the route's own `windowFor(user.id)` response then calls `computeWindow` -> `wallClock` -> `formatter(tz)`, which inserts a new `Intl.DateTimeFormat` into the module-level `dtfCache` Map. 3. The Map is never swept, bounded or keyed on anything normalised, so every request adds a permanent entry. `/api/settings` has no rate limit of any kind.

**Why it matters.** Authenticated remote memory exhaustion. Each request costs the attacker ~120 bytes and costs the server ~28 KB of resident memory that is never released while the process lives: ~36,000 requests is 1 GB, ~110,000 requests is 3 GB. The storage layer is single-process SQLite, so the OOM takes the whole deployment down for every user, and only a restart recovers it. The distinct-spelling space is effectively unlimited (case permutations of ~600 zone names, plus `Etc/GMT±n` and `+HH:MM` offset forms, all accepted).

**Evidence.**

src/lib/window.ts:36-54
```
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ... });
    dtfCache.set(timeZone, f);
  }
  return f;
}
```
src/lib/window.ts:95-102 `isValidTimeZone` accepts anything `new Intl.DateTimeFormat("en-US", { timeZone: tz })` accepts — verified case-insensitive: `America/New_York`, `america/new_york`, `AMERICA/NEW_YORK`, `aMeRiCa/nEw_YoRk`, `+05:30`, `+0530`, `Etc/GMT+5` are all accepted. src/lib/settings.ts:63-66 stores the raw string. src/app/api/settings/route.ts:7-11 has no rate limit and calls `windowFor(user.id)` on the way out, which is what populates the cache.

Retention measured in isolation, replicating formatter() exactly, with a forced GC before and after:
```
cached:    15000 distinct timezone spellings -> RSS +400.1 MB (27972 bytes retained per spelling), cache size 15000
discarded: 15000 distinct timezone spellings -> RSS +35.2 MB  (2458 bytes retained per spelling), cache size 0
```
The 16x gap between the two runs is the live Map holding native ICU formatter objects.

Against the running production server, one signed-in account:
```
2000/2000 settings writes accepted (each a distinct spelling of one real IANA zone)
server RSS 290 MB -> 391 MB  (+100.7 MB, 52799 bytes per request)
```

**Fix.** Two changes, either of which closes it, both of which are cheap. (1) Normalise before storing: in saveSettings, replace the raw string with the canonical form the platform reports — `new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).resolvedOptions().timeZone` — so every spelling of a zone collapses to one cache key and the key space becomes the ~600 real zone names. (2) Bound the cache in window.ts: cap `dtfCache` at a few hundred entries and evict (a simple `if (dtfCache.size > 500) dtfCache.clear()` before the insert is enough — rebuilding a formatter is only a few ms and the working set is one zone per active user). Add a test that pushes 1000 distinct spellings through `computeWindow` and asserts `dtfCache` stays bounded.


### L2-1 · medium — The account-wide sign-in ceiling is a remote account-lockout weapon: 100 wrong guesses lock any named user out of their own account

`src/app/api/auth/login/route.ts`:22 · CWE-645 · reproduced

**Who.** Any unauthenticated stranger who can reach the port and knows (or guesses) a victim's email address. They need no account, no credentials and no session.

**How.** 1. Learn a target address (it is the account name; /api/auth/signup also confirms which addresses exist — see L2-4). 2. POST /api/auth/login 100 times with {"email":"victim@example.com","password":"anything"}. In the documented default deployment TRUSTED_PROXY_HOPS is unset, so clientKey() returns null and both address-keyed buckets (PER_IP, PER_ACCOUNT_IP) are skipped entirely; the only bucket that runs is `login:acct:<email>` at 100 per 15 minutes. 3. The 101st request to that address — including the victim's, with the correct password — is answered 429. 4. Repeat ~100 requests every 15 minutes to hold the lockout open indefinitely. Nothing clears the bucket early: clearRateLimit() only touches `login:acct-ip:<email>:<ip>`, and it is unreachable anyway because the limiter gates the request before signIn().

**Why it matters.** Denial of service against any individual account, sustained for as long as the attacker cares to spend ~100 requests per 15 minutes (measured: 15 s of attacker time per window). The victim cannot get in, cannot change their password, and cannot reach any of their data; this app has no password reset and no out-of-band recovery, so there is no way around it but waiting. It also directly contradicts the design property the code and README both assert.

**Evidence.**

src/app/api/auth/login/route.ts:9-12 states the intended invariant: "A limit keyed on the account alone would let an attacker lock a real user out from any address with a handful of wrong guesses. So the strict limit is keyed on the account *and* the address". README.md:306-309 repeats it. But line 22 declares `const PER_ACCOUNT = { limit: 100, windowMs: 15 * 60_000 };` and line 53 applies it keyed on the account alone: `checks.push(rateLimit(`login:acct:${email}`, PER_ACCOUNT.limit, PER_ACCOUNT.windowMs));`. Lines 40/44/52 make the two address-keyed buckets conditional on `ip`, which src/lib/rate-limit.ts:86-88 returns as null whenever trustedProxyHops() is 0 — the default documented in .env.example:48 and README.md:316-325.

Reproduced against a production build (`next start`, SESSION_SECRET set, TRUSTED_PROXY_HOPS unset), output verbatim:

  signup victim: { s: 201, b: '{"id":"57b29d7c-...","email":"victim@example.com","displayName":"V' }
  victim can sign in: { s: 200, b: '{"id":"57b29d7c-...","email":"victim@example.com","displayName":"V' }
  100 wrong guesses took 15336 ms
  victim with the CORRECT password: { s: 429, b: '{"error":"Too many sign-in attempts. Try again shortly."}' }
  attacker's own account still works: { s: 201, ... }

The last line shows the lockout is targeted, not deployment-wide: only the named account is affected, so the attacker loses nothing. No test asserts this property — test/rate-limit.test.ts only covers clientKey().

**Fix.** Do not let a failed guess for an account deny that account's own successful sign-in. Two changes, either of which closes it, both worth making: (a) in src/app/api/auth/login/route.ts, run the account-wide bucket in *observe* mode rather than *deny* mode — count failures per account and, when the count is over PER_ACCOUNT.limit, still verify the password and let a correct one through (clearing the bucket on success, as line 62 already does for the account+address bucket), refusing only wrong guesses; (b) key the deny decision on something the attacker pays for rather than on the victim's identity — with TRUSTED_PROXY_HOPS set that is the address, and without it a proof-of-work or a global sign-in ceiling that is generous enough not to be a lockout. Concretely: move `clearRateLimit(`login:acct:${email}`)` alongside line 62 so a correct password always resets the account bucket, and change tooMany() so a block on `login:acct:*` alone adds a fixed delay instead of a 429. Add a regression test asserting that 200 wrong guesses for an address do not stop the correct password from succeeding, and correct README.md:306-309 and the comment at login/route.ts:9-12, which currently claim a property the code does not have.


### L2-2 · medium — Unauthenticated, unmetered scrypt on /api/auth/login: the only limit that runs first is keyed on the attacker's own chosen email

`src/app/api/auth/login/route.ts`:53 · CWE-770 · reproduced

**Who.** Any unauthenticated stranger who can reach the port. No account, no credentials, no session; in the default deployment they do not even need to vary source address.

**How.** 1. POST /api/auth/login with a *different* random email on every request. 2. `login:acct:<email>` is therefore a fresh bucket each time and never fires; `login:acct-ip:*` and `login:ip:*` are skipped entirely because clientKey() returns null with TRUSTED_PROXY_HOPS unset (the default). 3. Every one of those requests still reaches signIn(), which calls verifyPassword() against decoyHash() — a full 64-byte scrypt (N=2^14, r=8) on the libuv threadpool, which Node sizes at 4 threads by default. 4. Hold a few hundred in flight. Nothing throttles, nothing queues with a bound, and every other request in the single-process server waits behind the threadpool.

**Why it matters.** Amplified denial of service against the whole deployment from a trivial amount of attacker bandwidth. Measured: 400 concurrent requests totalling 50.8 KiB of body made an ordinary authenticated GET /api/feed go from ~10 ms to 1.7 s; 2000 requests totalling 245.5 KiB took 125 seconds of server time to drain and pushed a bystander request to 8.5 s. That is roughly 500x amplification from attacker bytes to server CPU-seconds. Every request was answered 401 — i.e. every one of them actually ran scrypt — and not one was answered 429. Secondary effect: each distinct email also creates a rate-limiter map entry keyed on that email, which readJson caps at 64 KB and the sweep holds for a full 15 minutes, so the same traffic is also a (1:2, bandwidth-bound) memory growth vector.

**Evidence.**

src/app/api/auth/login/route.ts:16-18 states the intended invariant: "Checking the password before the limit is not an option either: scrypt is deliberately expensive, so that would turn this endpoint into a CPU exhaustion vector." README.md:309-311 repeats it. The limit that runs before the check is line 53, `rateLimit(`login:acct:${email}`, ...)`, keyed on a string the attacker supplies; lines 40 and 44 make the only non-attacker-keyed guard conditional on `ip`, and src/lib/rate-limit.ts:86-88 returns null for `ip` whenever TRUSTED_PROXY_HOPS is 0. src/app/api/auth/signup/route.ts:8-14 shows the authors knew the shape of the problem and added `PER_DEPLOYMENT` as a floor for exactly this case; /api/auth/login has no equivalent floor. src/lib/crypto.ts:183-190 (verifyPassword) and :199-202 (decoyHash) confirm the unknown-address path pays the same scrypt as the known one — which is the deliberate anti-enumeration design, and is also what makes every flood request expensive.

Reproduced against a production build, output verbatim:

  idle  GET /api/feed ms: 194,9,18,6,11
  under GET /api/feed ms: 1710,63,38,42,6
  flood statuses: {"401":400} | bytes uploaded: 50.8 KiB
  (no 429 anywhere: not one request was throttled)

and at higher volume:

  during-flood /api/auth/me ms: 8508,15,15,14,15,21,7,9
  statuses: {"401":2000} wall ms: 124897 uploaded KiB: 245.5

Body-size handling itself is sound (60 KB email → 401 in 437 ms; 70 KB → 413; a 200 KB chunked body → 413), so MAX_REQUEST_BYTES is doing its job — it just does not bound how many such requests are accepted.

**Fix.** Give /api/auth/login a floor that does not depend on a value the caller picks, mirroring what signup already has. In src/app/api/auth/login/route.ts, before readJson (so it costs nothing to enforce), add `const PER_DEPLOYMENT = { limit: 600, windowMs: 15 * 60_000 }` on the fixed key `login:deployment` — sized generously so it is not itself a lockout (see L2-1/L2-3) but far below what saturates four scrypt threads. Better still, bound *concurrency* rather than rate: keep a counter of in-flight password verifications and answer 503 with Retry-After above, say, 8, so honest users queue briefly instead of everyone stalling. Also cap the email at MAX_EMAIL_LENGTH before it is used as a limiter key (`email.slice(0, 254)`) so map keys cannot be 64 KB — this is safe even though signIn deliberately has no ceiling, because it only affects the bucket name. Finally, correct the comment at login/route.ts:16-18 and README.md:309-311, which assert the endpoint is not a CPU exhaustion vector.


### L5-1 · medium — Provider-token encryption key is one unsalted SHA-256 of the operator's SESSION_SECRET, and the key id stored beside every ciphertext is a free offline verifier for it

`src/lib/crypto.ts`:47 · CWE-916 · reproduced

**Who.** Anyone who obtains a copy of daily-scroll.db without the server's environment: a misplaced or third-party backup, a snapshot, another local user or container process on the host (see L5-2, which makes the file world-readable in the configuration .env.example documents), or a support copy. They do not have .env, systemd's EnvironmentFile, or the process environment.

**How.** 1. Read any row of `connections`; its access_token is `keyId.iv.tag.ciphertext`, e.g. `rztHEATJ.clqb2WjfFgjN9FIZ.ZCnlr8jMROIcQwtqj2oqRg.XMDddA`. 2. Take the first field. It is `sha256(sha256(SESSION_SECRET))` base64url-truncated to 8 characters (crypto.ts:56-58, 88-95) — a 48-bit verifier for the secret, sitting in the stolen file. 3. Run a wordlist or pattern search: for each candidate of >= 16 characters compute two SHA-256 compressions and compare 8 characters. No AES, no salt, no iteration count, nothing per-deployment to grind. 4. On a match, `sha256(candidate)` IS the AES-256-GCM key (crypto.ts:47-49, 60-62), and it opens every ciphertext in the file. 5. Decrypt connections.access_token and connections.refresh_token for every user.

**Why it matters.** Plaintext OAuth access AND refresh tokens for every connected account on the deployment — TikTok, Instagram, YouTube, X, Facebook, Threads, Reddit, Pinterest, Twitch — plus Bluesky session/refresh JWTs and the user-chosen PDS host in `scope`. Refresh tokens make the access durable rather than a snapshot. This is the single asset the whole encryption-at-rest design exists to protect, and the app's own threat model for a stolen file ('a leaked backup, a world-readable DATA_DIR', README:389-391) is exactly this attacker. The password hashes in the same file cost 50.8 ms per guess; the token key costs 0.0046 ms per guess — the weaker secret protects the more valuable data.

**Evidence.**

src/lib/crypto.ts:47-49  `function keyFrom(material: string): Buffer { return crypto.createHash("sha256").update(material).digest(); }`
src/lib/crypto.ts:56-58  `function keyId(key: Buffer): string { return crypto.createHash("sha256").update(key).digest("base64url").slice(0, 8); }`
src/lib/crypto.ts:94      `return [keyId(key), ...[iv, tag, enc].map((b) => b.toString("base64url"))].join(".");`
src/instrumentation.ts:26 `if (!secret || secret.length < 16)`  — length is the only requirement; .env.example:4 says only '>= 16 chars'.

Ran crack.mjs against SESSION_SECRET="dailyscroll-prod-2026" (21 chars, passes the app's own check):
  operator secret: "dailyscroll-prod-2026" (21 chars)
  key id in row  : rztHEATJ (48 bits, no AES needed to test a guess)
  CRACKED: "dailyscroll-prod-2026" after 14143 candidates in 148 ms
  plaintext token: ya29.a0AfH6SMB_REAL_GOOGLE_ACCESS_TOKEN_EXAMPLE
  scrypt (password column) : 50.6 ms per guess
  sha256 (token key column): 0.010493 ms per guess  ->  4,821x cheaper

Tight-loop measurement of one candidate check (two SHA-256 + 8-char compare), single core, Node:
  candidates/sec, 1 core, Node: 216,038
  scrypt guesses/sec, 1 core: 19.7  (N=16384,r=8,p=1 defaults, 50.8 ms each)
SHA-256 is the most GPU-friendly primitive there is; a single consumer GPU does this search several orders of magnitude faster again, and the search needs no access to the server.

Confirmed end to end against a real database, not a mock: built the app, started it with SESSION_SECRET='dailyscroll-prod-2026', signed up and connected a platform, then read DATA_DIR/daily-scroll.db:
  {"user_id":"10634e18-...","provider":"youtube",...,"access_token":"rztHEATJ.clqb2WjfFgjN9FIZ.ZCnlr8jMROIcQwtqj2oqRg.XMDddA",...}
The key id in the live row is byte-identical to the one the cracking script matched on.

**Fix.** Stop using a bare hash as a KDF. In crypto.ts, replace `keyFrom` with a stretching derivation — `crypto.scryptSync(material, salt, 32, { N: 2**15, r: 8, p: 1, maxmem: 96*1024*1024 })` or `crypto.hkdfSync` over a PBKDF2/argon2 output — where `salt` is a per-deployment random value generated once and stored beside the database (a `key_salt` row or a file in DATA_DIR), so the search cannot be precomputed or shared across installs. Derive once at module load and cache the Buffer, since it is now expensive: `encrypt`/`decrypt` call it on every row. Keep the key id for rotation but stop making it a direct hash of the key: emit `crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'daily-scroll key id', 6)` (or an HMAC of a fixed label under the key) so a candidate cannot be tested without first paying the stretched derivation. Separately, tighten the admission check in instrumentation.ts:26 and .env.example:4 from 'at least 16 characters' to a real entropy requirement — reject anything under 32 characters, and say in both files that this must be generated (`openssl rand -base64 32`), not chosen.


### L5-2 · medium — The SQLite database, WAL and shared-memory files are created world-readable, and the owner-only directory mode is applied only when the app itself creates DATA_DIR

`src/lib/db.ts`:153 · CWE-732 · reproduced

**Who.** Any other local user, service account, sidecar or process on the host that runs the app — a shared VPS, a multi-service container, a backup or log-shipping agent running as a different uid. No credentials and no network access required.

**How.** 1. The operator follows .env.example:10 and sets `DATA_DIR=/var/lib/daily-scroll`, creating that directory themselves (`mkdir` -> 0755), or lets systemd `StateDirectory=` or a Docker volume mount create it (both 0755). 2. `fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })` is a no-op on a directory that already exists, so the 0700 is never applied. 3. SQLite then creates `daily-scroll.db`, `daily-scroll.db-wal` and `daily-scroll.db-shm` at 0644, and the code never chmods them. 4. `cat /var/lib/daily-scroll/daily-scroll.db` from any other account on the box.

**Why it matters.** Every user's email address and scrypt password hash, every AES-GCM ciphertext of a platform access and refresh token together with its key id (which is the input to L5-1), every Web Push endpoint with its p256dh and auth secrets, and the full viewing history (daily_feeds, seen_items, saved_items). README:389-391 names 'a world-readable DATA_DIR' as the threat this was fixed for and states the mitigation as '`DATA_DIR` is now also created owner-only' — that claim does not hold in the configuration .env.example itself recommends, and it never covered the file, which is the thing that is read.

**Evidence.**

src/lib/db.ts:150-157
  // Owner-only: the file underneath holds encrypted platform tokens and every session row,
  // and on a shared host the default permissions make that world-readable. Applies when the
  // directory is created; an existing one is left as the operator set it.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  ...
  const db = new DatabaseSync(file);
No chmod of `file` anywhere in the repository (grep for chmod in src/: no hits).

Measured, operator-created DATA_DIR (the .env.example shape), production build, NODE_ENV=production:
  $ mkdir -m 755 opdir
  $ DATA_DIR=.../opdir npx next start -p 3142      # then one signup
  $ stat -c '%n %a' opdir opdir/*
  opdir 755
  opdir/daily-scroll.db 644
  opdir/daily-scroll.db-shm 644
  opdir/daily-scroll.db-wal 644

For contrast, when the app does create the directory the mode is applied to the directory only — the file is still 0644 and is protected solely by the directory bit:
  $ ls -la notenote-copy/data
  drwx------  2 root root   4096 .
  -rw-r--r--  1 root root   4096 daily-scroll.db
  -rw-r--r--  1 root root 185432 daily-scroll.db-wal

**Fix.** In getDb(), after `new DatabaseSync(file)` (and after the first `db.exec`, so the WAL and SHM exist), restrict the files rather than relying on the directory: for each of `file`, `${file}-wal`, `${file}-shm`, `try { fs.chmodSync(p, 0o600); } catch {}`. Do the same for the directory unconditionally instead of only at creation — `fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dataDir, 0o700); } catch {}` — or, if an operator-set mode should be respected, detect `mode & 0o077` and refuse to start with a message naming the path, the way instrumentation.ts already refuses a missing SESSION_SECRET. Setting `process.umask(0o077)` before opening the database is an alternative that also covers files SQLite creates later. Then correct README:391 to say what is actually enforced.


### L1-3 · low — The push endpoint network guard runs only at registration, never at send, so a name that resolved publicly once puts the daily job onto an internal address

`src/lib/push.ts`:149 · CWE-918 · reproduced

**Who.** Any signed-in account that controls a DNS name (registration is open).

**How.** 1. Register `https://push.attacker.tld/x` as a push subscription while `push.attacker.tld` resolves to a public address. `isReachableEndpoint` runs `assertPublicHost` once, at POST /api/push/subscribe, and accepts it. 2. Re-point the name at `127.0.0.1`, `169.254.169.254`, or any RFC1918 address. 3. `POST /api/cron/notify` runs every minute per the README's crontab; `notifyHourOpen` reads the stored endpoint straight out of the row and hands it to `webpush.sendNotification` with no further check, so the server connects to the internal address. Up to 20 endpoints may be registered per account, and delivery is retried daily (and on every notify run until it succeeds, since `last_open_day` is only written after a 2xx).

**Why it matters.** The server can be made to open TCP+TLS connections to arbitrary addresses on the network it can reach and the attacker cannot, once per notify run per endpoint. The encrypted payload does not reach the service (the internal host's certificate will not match the attacker's hostname, so the handshake fails), so this is a reachability and port-existence probe rather than data disclosure — but it is precisely the case the README claims is closed: 'A push endpoint is a URL the client chooses and the server POSTs to every day... it goes through the same network guard as a Bluesky PDS.' The Bluesky guard deliberately runs 'before every request to that host, not only when the connection is made, so a name that resolved publicly at connect time cannot be repointed later' (src/lib/providers/bluesky.ts:71-80); the push path does the opposite. This makes the fix recorded for SEC-5 in REVIEW.md incomplete: it closed registration of a literal private address but left the re-pointing case the sibling guard was specifically written to cover.

**Evidence.**

Guard is called exactly once, at registration: `grep -rn 'assertPublicHost|isReachableEndpoint' src/` gives src/app/api/push/subscribe/route.ts:20 `if (!(await isReachableEndpoint(body.subscription.endpoint)))` and src/lib/push.ts:57-70 (the definition) — and nothing on the send path.

src/lib/push.ts:146-151 (send path, no guard):
```
  await Promise.all(
    due.map(async (row) => {
      try {
        await webpush.sendNotification(toWebPush(row), payload, { TTL: 60 * 50 });
```
Contrast src/lib/providers/bluesky.ts:76-80, which re-checks on every use:
```
async function checkedService(input: string | undefined): Promise<string> {
  const service = normaliseService(input);
  await assertPublicHost(new URL(service).hostname);
  return service;
}
```

Reproduced with a listener on loopback standing in for the re-pointed host (the row is what the cron reads, so writing it directly is the same as having registered a name that later resolved there):
```
 ✓ refuses a loopback endpoint at REGISTRATION time
 ✓ but the daily send path never re-checks the stored endpoint
   delivery result: { sent: 0, removed: 0, failed: 1 }  TCP connections observed on the internal port: 1
```

**Fix.** Re-check the destination where it is used, the way bluesky.ts does. In `notifyHourOpen`, before `webpush.sendNotification(toWebPush(row), ...)`, run `if (!(await isReachableEndpoint(row.endpoint))) { result.failed++; return; }` — or better, delete the row, since an endpoint that no longer resolves publicly is not a push service. Optionally also restrict registration to the known push-service hosts (fcm.googleapis.com, updates.push.services.mozilla.com, *.notify.windows.com, web.push.apple.com and their regional forms) with an env override, which removes the class rather than the instance. Extend test/push.test.ts with a case that stores a loopback endpoint directly and asserts notifyHourOpen refuses it.


### L1-4 · low — Query parameter used as a bare object key: /connect?error=__proto__ makes Object.prototype the error text and kills the Connections page render

`src/components/ConnectionsPanel.tsx`:90 · CWE-1321 · reproduced

**Who.** Anyone who can get a signed-in user to open a link — a message, a post, an email, a redirect from any site.

**How.** 1. Send the victim `https://<app>/connect?error=__proto__`. 2. `errorParam.replace(/^[a-z]+-/, "")` leaves `__proto__`, and `ERRORS["__proto__"]` is a plain object literal lookup, so it returns `Object.prototype` rather than undefined. 3. `?? "Something went wrong."` does not fire because the value is not nullish, so `errorText` is an object. 4. `{errorText}` in JSX throws 'Objects are not valid as a React child'; the server render of the Suspense boundary that holds ConnectionsPanel errors out and the same expression throws again on the client.

**Why it matters.** The whole Connections UI is gone for that page load — the platform list, the connect and disconnect buttons and the Bluesky credential form all fail to render. Reproduced against a production build: the page still answers 200 but contains zero provider cards against 11 on a normal load. It is a reflected client-side denial of service on one page, not code execution, hence low; `?error=constructor` and `?error=toString` reach the same lookup and yield functions (React warns and renders nothing). The same shape is a documented invariant in this author's sibling repositories ('Whitelists are own-property lookups (`has(TABLE, id)`), never a bare `TABLE[id]`: every name on `Object.prototype` — `constructor`, `__proto__`, `toString` — is truthy on a plain table').

**Evidence.**

src/components/ConnectionsPanel.tsx:11-18 declares `const ERRORS: Record<string, string> = { "unknown-provider": ..., denied: ..., ... }` — an object literal, so it inherits from Object.prototype. Line 89-90:
```
  const errorParam = params.get("error");
  const errorText = errorParam ? ERRORS[errorParam.replace(/^[a-z]+-/, "")] ?? "Something went wrong." : null;
```
Line 122 renders it: `{errorText && <p className="error">{errorText}</p>}`.

Lookup behaviour confirmed in node:
```
"__proto__"       ->key "__proto__"   -> object   [object Object]
"constructor"     ->key "constructor" -> function function Object() { [native code] }
"yt-__proto__"    ->key "__proto__"   -> object   [object Object]
```

Against `next start` (production build), signed in:
```
GET /connect?error=__proto__   status=200 bytes=14470   provider cards rendered: 0
GET /connect                   status=200 bytes=30816   provider cards rendered: 11
```
and the streamed HTML for the broken load carries the errored boundary: `<template data-dgst="1800917955"></template>`. In the dev build the message is spelled out: `Switched to client rendering because the server rendering errored: Objects are not valid as a React child (found: object with keys {})`.

**Fix.** Make the lookup an own-property one and keep the result a string: `const key = errorParam.replace(/^[a-z]+-/, ""); const errorText = Object.prototype.hasOwnProperty.call(ERRORS, key) ? ERRORS[key] : "Something went wrong.";` — or declare the table with `Object.create(null)` / a `Map`, or add a `typeof v === "string"` guard before rendering. The same shape should be checked at src/lib/providers/meta.ts:51 (`providerName`) and src/components/PlatformLogo.tsx:20, which are safe today only because their keys never come from a request.


### L1-5 · low — A user-chosen Bluesky host can put arbitrary text into the app's own error message on the Connections page, and it is not logged

`src/lib/providers/bluesky.ts`:110 · CWE-451 · reproduced

**Who.** Whoever runs the AT Protocol host a user types into the 'Service host' field — an attacker who persuades a user to point at their 'mirror'/'proxy' PDS, or who controls a PDS a user already uses.

**How.** 1. Get the user to enter `https://<attacker-host>` as their Bluesky service host on the Connections page. The host resolves publicly, so `assertPublicHost` passes — this is the supported, intended configuration. 2. Answer `POST /xrpc/com.atproto.server.createSession` with HTTP **200** (not an error status) and a body of `{"error":"...","message":"<anything>"}`. 3. bluesky.ts:110 wraps that message in a `UserFacingError`, `credentialConnectError` returns it unchanged because it is a UserFacingError, and the route hands it back as `{"error": "Bluesky: <anything>"}`, which ConnectionsPanel renders as the app's own red error line.

**Why it matters.** Attacker-controlled, unbounded text is displayed as if the application had written it, in the exact place a user is looking while typing a credential — so a convincing 'your app password was rejected, get a new one at <url> and paste it here' is trivial. It is not cross-site scripting (React escapes it) and the host was named by the user, which is why it is low. It is nonetheless the one leak channel the code and README claim is shut: connections.ts:222-227 says 'The sentence is fixed rather than quoted from the reply: the service host is chosen by the user, so its wording — and its 200 bytes of upstream body — is attacker-controlled text', and the README says 'Nothing from the reply is quoted'. That holds for every non-2xx reply (getJson turns those into ProviderHttpError, which credentialConnectError answers generically) and fails for a 200 carrying an `error` key. `log: false` on this branch also means the operator never sees it.

**Evidence.**

src/lib/providers/bluesky.ts:105-110
```
      const session = await getJson<Session>("bluesky", `${service}/xrpc/com.atproto.server.createSession`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (session.error) throw new UserFacingError(`Bluesky: ${session.message ?? session.error}`);
```
src/lib/connections.ts:229-235
```
export function credentialConnectError(err: unknown, providerName: string): CredentialConnectFailure {
  if (err instanceof UserFacingError) return { message: err.message, log: false };
```
src/app/api/connect/[provider]/credentials/route.ts:50 `return json({ error: answer.message }, { status: 400 });` and src/components/ConnectionsPanel.tsx:69 `{error && <p className="error">{error}</p>}`.

Reproduced by pointing the real provider at a local https server that answers 200 with an `error`/`message` body and running the thrown error through the real `credentialConnectError`:
```
thrown: UserFacingError | Bluesky: Your app password was rejected. Reset it at https://bsky-security.example/reset and paste the new one here.
shown to the user: "Bluesky: Your app password was rejected. Reset it at https://bsky-security.example/reset and paste the new one here." | logged: false
 ✓ echoes an attacker-controlled 'message' from a 200 reply verbatim
```
(The repro set ALLOW_PRIVATE_PROVIDER_HOSTS=1 only so the test server could live on loopback; a real attacker uses a public host, which the guard permits by design.)

**Fix.** Stop quoting the reply on the 2xx path too. At src/lib/providers/bluesky.ts:110 throw a fixed sentence and leave the detail for the log, mirroring what credentialConnectError already does for a refused status: `if (session.error || !session.accessJwt) throw new ProviderHttpError("bluesky", 401, String(session.error ?? ""));` — which routes it to the existing 'Bluesky did not accept those credentials.' branch and sets log: true. If a distinction is wanted (for example AT Protocol's `AuthFactorTokenRequired`, which is a real user-actionable case), match the known `session.error` codes against a fixed allow-list and map each to the app's own sentence; never interpolate `session.message`. Add a test asserting that a 200 reply carrying an `error`/`message` pair does not put either string into what the route returns.


### L2-3 · low — 200 empty POSTs stop anyone registering on the whole deployment for an hour

`src/app/api/auth/signup/route.ts`:14 · CWE-770 · reproduced

**Who.** Any unauthenticated stranger who can reach the port.

**How.** 1. POST /api/auth/signup 200 times with an empty JSON object `{}`. rateLimit("signup:deployment", 200, 1h) is consumed at line 20 *before* readJson and before signUp, so a body that fails validation still spends one of the 200 — the attacker never pays for a scrypt hash and never creates an account. 2. Every subsequent registration attempt by anybody, for the remainder of the fixed hour window, is answered 429 "Too many accounts created from here." 3. Repeat 200 requests an hour to hold it.

**Why it matters.** Deployment-wide registration outage for a cost of ~5 KB and 6 seconds per hour. Existing users are unaffected, which is why this is low, but for a self-hosted app whose front page is a sign-up form it means nobody new can join for as long as the attacker cares to keep it up, and the operator sees no cause but a 429.

**Evidence.**

src/app/api/auth/signup/route.ts:8-14 claims the opposite: "Deliberately far above any honest hour so that exhausting it is not a cheap way to stop other people registering" — `const PER_DEPLOYMENT = { limit: 200, windowMs: 60 * 60_000 };`. Line 20 consumes it unconditionally, ahead of readJson at line 29 and signUp at line 30, so a malformed request costs the attacker nothing and the deployment one slot. src/lib/rate-limit.ts:35-46 is a fixed window whose resetAt is not extended, so 200 requests per hour sustain it exactly.

Reproduced against a production build, output verbatim:

  after 200 empty signups: { s: 400, b: '{"error":"Enter a valid email address"}' } ms 6292
  honest new user: { s: 429, b: '{"error":"Too many accounts created from here. Try again later."}' }

A later run against the same process confirmed the block persists across unrelated requests for the rest of the window.

**Fix.** Charge the deployment bucket only for requests that actually created an account, not for every POST. In src/app/api/auth/signup/route.ts, keep a cheap unconditional guard (e.g. `signup:deployment:attempts` at a much higher ceiling) but move the consumption of the real ceiling to after signUp() returns successfully — rateLimit() can be split into a peek (`remaining`) before and an increment after, or simply call rateLimit once the user row exists and refuse only if it was already over. That way 200 malformed posts cost nothing, and 200 genuine registrations in an hour — the case the ceiling is actually for — still trips it. Raise the ceiling as well, or make it configurable (SIGNUP_LIMIT_PER_HOUR), since a deployment-wide fixed number is a lockout surface by construction.


### L2-4 · low — Sign-up reveals which email addresses have accounts, defeating the decoy-hash defence sign-in goes to some trouble to provide

`src/lib/auth.ts`:46 · CWE-204 · reproduced

**Who.** Any unauthenticated stranger who can reach the port.

**How.** 1. POST /api/auth/signup with {"email":"target@example.com","displayName":"x","password":"password123"}. 2. A registered address answers 400 with "An account with that email already exists"; an unregistered one answers 201 and creates a throwaway account (or, if the attacker prefers not to create anything, a registered address still answers 400 while an unregistered one answers 201, and a unique-index violation is never reached). 3. Repeat for a list of addresses, bounded only by the deployment ceiling of 200/hour (or 5/hour/address when TRUSTED_PROXY_HOPS is configured).

**Why it matters.** Account enumeration: an attacker learns which of a list of email addresses hold accounts on this server. On its own that is low — but it is exactly the input L2-1 needs to target a lockout, and it makes worthless the decoy-hash machinery, the deliberately vague WRONG_CREDENTIALS message and the timing test that exist solely to stop /api/auth/login answering this question. The README states the property as a security feature; a second unauthenticated endpoint gives it away in one request.

**Evidence.**

src/lib/crypto.ts:192-202 exists only for this: "A real hash of a value nobody knows, so a sign-in attempt for an account that does not exist can spend the same time as one that does. Without it the response is roughly ten times faster for an unknown address, which tells an attacker exactly which addresses are registered and makes the deliberately vague error message pointless." src/lib/auth.ts:71-81 pairs that with a single WRONG_CREDENTIALS string for both outcomes. src/lib/auth.ts:45-46 then says it outright: `const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email); if (exists) throw new UserFacingError("An account with that email already exists");`.

I first confirmed the sign-in defence really does hold, so that this finding is about the sign-up channel and not a timing claim. Interleaved and warmed-up measurement against a production build (30 paired samples):

  registered  median 57.6 mean 59.8
  unknown     median 62.8 mean 64.4

Indistinguishable. Then the sign-up channel, verbatim:

  signup with an address that exists: {"error":"An account with that email already exists"}
  signup with a fresh address: 201

**Fix.** Make sign-up answer the same way whether or not the address is taken. Since this app has no email delivery, the honest options are (a) answer 202 with a neutral message for both cases and, when the address already exists, create nothing — the legitimate owner then finds out by signing in, and the person who typed a wrong address gets 'if that address is free, your account is ready; try signing in' — or (b) accept the disclosure deliberately and drop the pretence at sign-in, which is worse. Option (a) needs the sign-up response to stop returning the user id/email (src/app/api/auth/signup/route.ts:37) in the taken case and the client (src/components/AuthForm.tsx:22-34) to route to /feed only when a session cookie actually came back. Whichever is chosen, make the code and README say the same thing: today src/lib/crypto.ts:192-202 claims a property that src/lib/auth.ts:46 gives away.


## Checked and sound

What the reviewers tried and could not break. Recorded so it is not re-raised, and so a future change that undoes one of these is recognisable as a regression.

- SQL injection: every statement in db.ts, session.ts, auth.ts, settings.ts, feed.ts, library.ts, connections.ts and push.ts is parameterised. The only interpolated identifiers are the hard-coded table list in src/app/api/account/route.ts:15 and the hard-coded table name in db.ts ensureColumn/PRAGMA table_info. Query-parameter values (/api/muted?provider=&creatorHandle=, /api/saved?key=, /api/push/subscribe?endpoint=) all reach placeholders.
- XSS/DOM: there is no dangerouslySetInnerHTML, innerHTML, eval, new Function or dynamic import anywhere in src/ or public/ (grepped). Every platform-supplied string (title, creator, creatorHandle, error text) is rendered as a React text child or attribute and escaped. Demo poster SVGs XML-escape their text (demo.ts:142).
- getJson's hand-rolled redirect following: re-checked every hop against assertPublicHost, verified that the explicit `headers`, `body`, `method`, `redirect: "manual"` and `signal` all come after the `...init` spread so nothing from init can reinstate a deleted header, confirmed Authorization and Cookie are dropped when the origin changes (and that the comparison is against the previous hop, which chains correctly because a dropped header is never re-added), confirmed 303 and POST-301/302 degrade to GET without a body, confirmed non-http(s) schemes are refused, the chain is bounded at 5 hops, redirect bodies are cancelled rather than read, and only the final body is buffered, through a counting stream capped at 512 KB.
- net-guard numeric-address bypasses: tried the classic alternative IPv4 spellings against the real code path. dns.lookup resolves 2130706433, 0x7f000001, 017700000001 and 127.1 all to 127.0.0.1, and assertPublicHost checks the resolved addresses rather than the typed string, so each is refused; 127.0.0.1. is ENOTFOUND for both the guard and undici, so they agree. IPv4-mapped and IPv4-compatible IPv6 forms are expanded and re-checked as IPv4 (net-guard.ts:82-86). The guard requires every resolved address to be public, which is stricter than the single address undici will connect to.
- Prototype-chain keys other than the ConnectionsPanel one: getProvider (providers/index.ts:50) does a bare PROVIDERS[id] lookup on a request-supplied string, but `constructor`/`__proto__`/`toString` are rescued by the following `enabledProviderIds().includes(provider.id)`, since `.id` is undefined on all of them — verified by reading, and it is fragile rather than broken. PROVIDER_META[provider] in PlatformLogo/providerName and perProvider[provider] in curation.ts are keyed on provider ids that only ever come from first-party provider modules, never from a response or a request. settings.ts writes prefs through a fixed `as const` key list, and nothing in the app deep-merges parsed JSON, so JSON.parse's own-property `__proto__` cannot pollute anything.
- ReDoS: walked every regex that sees untrusted input — EMAIL_RE (auth.ts:6) on an unbounded sign-up address, parseIsoDuration (http.ts:163) on a YouTube duration, serviceFromScope, normaliseTitle's four passes over a title, the twitter t.co strip, safeNextPath and parseWindowStart. None nests a quantifier inside a quantifier; each backtracks linearly, and normaliseTitle's input is already truncated to 200 characters by sanitiseItems.
- Item pipeline bounds: sanitiseItems (providers/types.ts:160) is applied once in collectItems so it covers all eleven adapters, truncates text to 200 and URLs to 2000 characters, drops items with no key or permalink, coerces metrics with Number.isFinite and caps at 200 items per provider, which bounds provider_cache and daily_feeds. Fed it hostile-shaped values on paper (Infinity metrics, NaN publishedAt, duplicate keys, 5000 entries) — the worst outcome is a NaN score that makes the attacker's own feed order arbitrary, with no crash and no unbounded storage.
- MediaItem URL fields are not scheme-validated in sanitiseItems (a `javascript:` permalink would reach window.location.href in open-native.ts:42 and window.open at :20), but there is no path to one today: bluesky — the one host a user picks — builds its permalink from a fixed `https://bsky.app/...` prefix, and every adapter that passes a permalink through raw (instagram, threads, facebook, tiktok, twitch) takes it from that platform's own fixed API host. Saved items are copied out of the user's own frozen feed, so nothing can be injected there either. Worth hardening, not a reachable defect.
- CSRF: assertSameSite (api.ts:47) refuses any state-changing request whose Sec-Fetch-Site is not same-origin/none, falls back to an Origin comparison against APP_BASE_URL, and readJson independently insists on application/json — a cross-site form can send neither header nor that content type. Confirmed sec-fetch-site: same-site is refused, that safe methods short-circuit, and that the cron routes are protected by the bearer token instead (a cross-site page cannot set Authorization without a preflight it will not get).
- Ownership on every write path: saveItem only accepts a key present in one of the caller's own last seven frozen feeds (library.ts:18-32), markSeen only keys present in the caller's last three (feed.ts:197-215) — which also bounds seen_items growth — muting is capped at 500 with a provider checked by PROVIDER_IDS.includes, push subscriptions refuse a cross-user upsert via `WHERE push_subscriptions.user_id = excluded.user_id` and DELETE is scoped to the caller. Tried to find a per-user row reachable by guessing an id and could not: every statement carries user_id.
- Session and credential handling in the L1 direction: the cookie value is sha256'd before it touches SQL (session.ts, crypto.ts:169), currentSessionKey returns the hash so changePassword/revokeOtherSessions compare like with like, and decrypt distinguishes a wrong key from corruption without echoing OpenSSL's message.
- Error surfaces: errorResponse (api.ts:74) returns a message only for UserFacingError and logs everything else behind a flat 500; failureReason (connections.ts:191) reduces a provider failure to a fixed classified string before it is frozen into daily_feeds and re-served by /api/feed and the account export. The only string that still crosses from a response to a client is the Bluesky 200-with-error case reported as L1-5.
- GET /api/connect/:provider/start changes state (it writes an oauth_states row) and SameSite=Lax sends the cookie on a cross-site top-level GET, so a third-party page can make a signed-in victim create rows. Impact is bounded: the same handler deletes every state older than 15 minutes on each call, the row grants nothing without the platform's own consent screen, and completing the flow still requires the state to match the victim's user id. Not a finding, but the closest thing to one in the OAuth routes.
- Feed generation cannot be amplified: generateOnce (feed.ts:128) single-flights on userId:dayKey, the daily_feeds row freezes the result, and the handful of distinct dayKeys a user can reach by cycling their timezone caps the number of provider fan-outs per day at two or three. PROVIDER_TIMEOUT_MS and PROVIDER_BUDGET_MS bound each platform, and the rate limiter's bucket map is swept every 60 s.
- public/sw.js openWindow(data.url) takes its target from the push payload, which would be an open redirect if a payload could be forged — but a push must be encrypted to the subscription's own p256dh/auth and signed under the VAPID key the push service pinned at subscribe time, and the server only ever sends the literal "/feed". No reachable path.
- Every authenticated route really is wrapped. I enumerated all 22 route handlers under src/app/api and confirmed each is either withUser() (account, account/export, account/password, account/sessions, connect/[provider], connect/[provider]/credentials, connections, feed, feed/seen, muted, push/subscribe, saved, settings), explicitly calls currentUser() and redirects (connect/[provider]/start, connect/[provider]/callback), gated by CRON_SECRET (cron/notify, cron/prewarm), or deliberately public (auth/login, auth/signup, auth/logout, auth/me, push/key — which returns only the VAPID *public* key). Probed live: /api/feed, /api/saved, /api/settings, /api/connections, /api/account/export, /api/account/sessions, /api/push/subscribe and /api/muted all answer 401 with no cookie. All six server pages (page, feed, connect, saved, settings) call currentUser() and redirect before touching data.
- Password change really does end other sessions. Signed one account in on four devices, changed the password on one: response {"changed":true,"revokedSessions":3}; the changing device still resolved to the user afterwards and all three others returned {"user":null}. DELETE /api/account/sessions behaves the same ({"revoked":2,"sessions":1}) and POST /api/auth/logout kills only the calling device. The subtle half of this is right too: changePassword and revokeOtherSessions compare `token != ?` against currentSessionKey(), which returns the sha256 of the cookie — the form the table actually stores — so the device doing the change is correctly exempted rather than accidentally signed out.
- Sessions are stored as a hash and the hash is not a credential. createSession inserts hashToken(token) and sets the raw token in the cookie; currentUser() looks up by hash with `expires_at > ?`. I confirmed against the running server that the cookie value and the stored column differ, and the repo's own test (test/session.test.ts) derives the expected stored form independently from the spec and asserts that presenting the stored value is not a sign-in. Cookie flags are HttpOnly, SameSite=Lax, Secure (NODE_ENV=production under `next start` — verified in the live Set-Cookie), Path=/, host-only, maxAge equal to the 30-day server TTL.
- The sign-in timing oracle is genuinely closed. With warm-up and interleaved sampling (30 pairs) a registered address measured median 57.6 ms and an unknown one 62.8 ms — indistinguishable. A naive measurement without warm-up shows 226 vs 79 ms, which is a JIT/module-load artefact of measuring the first batch, not a leak; I checked this specifically before drawing a conclusion. decoyHash() is memoised so the decoy is computed once and both paths then pay exactly one 64-byte scrypt.
- No per-user object is reachable by an id the caller supplies. I grepped every db.prepare() call in src/ and checked each: saveItem/markSeen validate the key against the caller's own frozen daily_feeds rows before writing; unsaveItem, unmuteCreator, listSaved, listMuted, savedKeys, recordHourOpen, streakFor, getSettings/saveSettings, listConnections, disconnect and collectItems are all scoped by user_id; the account export binds user.id to every statement; removeSubscription(endpoint) is preceded by an explicit subscriptionsFor(user.id) ownership check. The only statements not scoped by user_id are the housekeeping sweeps, the cron fan-outs and the oauth_states lookup, all of which are either internal or checked below.
- The push-subscription takeover (REVIEW MISS-4) is properly fixed. I reproduced the upsert against node:sqlite in isolation: bob registering an endpoint gives changes=1; alice posting the same endpoint gives changes=0 (so saveSubscription returns false and the route answers 409) and the row still belongs to bob; bob re-registering still gives changes=1, so a genuine re-subscription is unaffected. The residual 409-vs-200 existence oracle is not practically exploitable given the entropy of a push endpoint.
- OAuth state binding holds. connect/[provider]/start writes a 24-byte random state bound to (user_id, provider) with a 15-minute TTL; the callback deletes the row before validating (single use) and then requires row.user_id === user.id, row.provider === provider.id and an age under 15 minutes. A forged callback (GET /api/connect/tiktok/callback?code=abc&state=guessed) with no session redirects to /?next=/connect and connects nothing. There is no way for one account to graft its own platform connection onto another account's row.
- The cross-site guard covers every state-changing route and both of its layers work. Live: a POST to /api/auth/login carrying Sec-Fetch-Site: cross-site and Content-Type: text/plain (the smuggled-JSON form attack the guard exists for) is refused 403 'Cross-site request refused'; the same body with no fetch metadata but Origin: https://evil.example is also 403; with no headers at all it reaches readJson and is refused 'Request body must be JSON'. assertSameSite runs inside withUser ahead of requireUser, so every authenticated mutation is covered, and the cron routes are bearer-gated (401 with no or a wrong Authorization) rather than cookie-gated, so they are not CSRF-reachable.
- The rate limiter's proxy handling is correct in both directions. trustedProxyHops() defaults to 0 and clientKey() then returns null rather than a shared constant, so callers skip the address-keyed buckets instead of collapsing every client into one — the deployment-wide lockout of REVIEW MISS-1 is genuinely gone. With N hops it takes the Nth entry from the right of X-Forwarded-For (what the nearest trusted proxy wrote), requires the chain to be at least N long, and validates the entry with net.isIP after stripping brackets/port — so a direct client cannot pick its own bucket. I also checked the bucket key namespace for collisions (`login:acct:`, `login:acct-ip:`, `login:ip:`, `signup:ip:`, `signup:deployment`, `password:`, `credconnect:`): no attacker-chosen string can make one key alias another.
- Request bodies are bounded and the bound cannot be walked around. Content-Length is used only as an early refusal; the real guard is a counting stream, so chunked transfer encoding does not evade it. Live: a 60 KB email is accepted (401), a 70 KB body is 413, and a 200 KB chunked body with no Content-Length is 413. readJson additionally insists on application/json, which a cross-site form cannot produce.
- Provider ids from the URL path cannot reach a prototype property. PROVIDERS is a plain object literal, so `PROVIDERS['constructor']` is truthy — but getProvider() then requires enabledProviderIds().includes(provider.id), and Object/Function/Object.prototype have no `id`. Live: POST and DELETE /api/connect/{constructor,__proto__,toString,valueOf,hasOwnProperty} all answer 404 while /api/connect/tiktok answers 200.
- No secret reaches the client. Grepped .next/static and .next/server/app for SESSION_SECRET, CRON_SECRET, VAPID_PRIVATE and the literal values I ran the server with: nothing. No NEXT_PUBLIC_* variable exists. /api/push/key returns only the VAPID public key. The account export deliberately omits access/refresh tokens. Nothing is written to localStorage, sessionStorage or document.cookie anywhere in src/components.
- Error and log channels do not leak internals. errorResponse only echoes UserFacingError messages; everything else (SQLite constraints, JSON.parse failures, DecryptionError, ProviderHttpError with up to 200 bytes of upstream body) is console.error'd and answered with a flat 500 'Something went wrong'. collectItems stores a classified reason ('timed out', 'authorisation expired', 'http 503') in the frozen feed rather than the raw message. The one place that still quotes a platform is bluesky.ts:107, which forwards session.message from a 2xx reply carrying an `error` field — but that host is the connecting user's own choice, the text is shown only to them, and React escapes it, so it is not a boundary crossing.
- Token encryption at rest and its rotation story are coherent. Ciphertexts are AES-256-GCM with a random 12-byte IV and now carry a key id (a hash of the key, so it reveals nothing about the secret); decrypt() selects by key id, still accepts the old three-part format by trying each configured key, and raises a distinct DecryptionError that listConnections surfaces as needsReconnect instead of a silent empty feed. PREVIOUS_SESSION_SECRETS makes rotation graceful. The dev fallback key is still a public constant but instrumentation.ts now warns loudly on every non-production boot and refuses to start production at all, which is what REVIEW MISS-5 asked for.
- Security headers are decided per request, not baked at build. Confirmed live on an API response: Content-Security-Policy with frame-ancestors 'none', X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, Cross-Origin-Opener-Policy: same-origin, Permissions-Policy, Cache-Control: no-store, and no X-Powered-By. HSTS correctly absent for the http:// APP_BASE_URL I ran with. No Access-Control-Allow-* header is set anywhere, so none of these JSON endpoints is cross-origin readable.
- Account deletion leaves nothing behind. The explicit loop covers sessions, settings, connections, daily_feeds, hour_opens, seen_items, saved_items, muted_creators, then provider_cache, oauth_states and the user row; push_subscriptions has ON DELETE CASCADE and PRAGMA foreign_keys = ON is set at open, so it goes with the user. The typed-email confirmation is enforced server-side (body.confirm !== user.email), not only in the form.
- The repository's own suite is green — 21 files, 230 tests — and I checked that none of the four findings above is covered by it: test/rate-limit.test.ts exercises only clientKey(), and nothing asserts that a correct password still works after a burst of wrong ones, that sign-in throughput is bounded, or that sign-up does not disclose registration.
- IV generation: every encrypt() takes a fresh crypto.randomBytes(12) (crypto.ts:90). Grepped all of src/ — there is no second construction site, no counter, no derived or reused IV, and no code path that encrypts twice under a caller-supplied nonce. The GCM random-IV birthday bound (~2^32 messages per key) is nowhere near reachable: one ciphertext per connection per refresh.
- Key id authentication: keyId sits outside the AEAD and no AAD is ever set, so a ciphertext is bound neither to its key id nor to the (user_id, provider) row it lives in. I tried to build an attack and could not: every SQL statement is parameterised, and decrypt()/isDecryptable() are only ever called on values the server itself wrote (connections.ts:88, 150, 157) — no route, import, share link or provider response reaches them. Tampering with the key id yields either 'no such key' or a GCM tag failure, both mapped to the same DecryptionError and both surfaced to a client only as the fixed string 'needs reconnecting' (connections.ts:193), so there is no oracle. It becomes exploitable only for an attacker who already has database write, which subsumes it. Worth binding anyway (AAD = keyId + user_id + provider + column), but not a finding today.
- GCM tag length is not pinned: open() calls createDecipheriv('aes-256-gcm', key, iv) with no authTagLength (crypto.ts:98), so Node accepts a truncated tag. Measured on Node 22.22.2: 16, 15, 12, 8 and 4-byte tags all authenticate the same ciphertext; only 3 bytes is rejected. A 4-byte tag would give a 2^-32 forgery chance per attempt — but, as above, nothing attacker-chosen reaches decrypt(), so there is no forgery attempt to make. Same for the IV length, which is also unvalidated (an 8-byte IV round-trips).
- The documented development fallback key cannot be reached by a built server, and I could not construct a deployment shape where it is. `next build` (turbopack) inlines process.env.NODE_ENV as "production" into the server chunks regardless of the shell's value, so secret()'s fallback branch is dead-code-eliminated: grepping .next for the literal 'daily-scroll-dev-secret-change-me' finds it only in .js.map files, never in a served .js, and the built crypto chunk reads `if (s && s.length>=16) return s; throw Error("SESSION_SECRET must be set (>= 16 chars) in production")`. Built with NODE_ENV unset, =staging and =development: the staging build still inlines production; the development build fails outright ('Export encountered an error on /_global-error'). Booting the built server with NODE_ENV=staging and no SESSION_SECRET, instrumentation's register() threw and every request answered 500 — fail closed, verified with curl. Note the README's stated reason is wrong (`next start` only defaults NODE_ENV when it is unset — next/dist/bin/next:84 — so `NODE_ENV=staging npm start` really does keep 'staging'); the guarantee holds for a different reason than the one documented.
- Related to the above and outside this lens, but measured: because security-headers.ts deliberately reads NODE_ENV at request time rather than build time, a production build started with NODE_ENV=staging serves `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `connect-src 'self' ws:`. Confirmed with curl against the built server. Worth an L3 look.
- Session token handling: 32 bytes of crypto.randomBytes, and the database stores only sha256(token) (session.ts:17-21, crypto.ts:169-171). Verified against a live database that the sessions.token column holds a value that is not the cookie. Every comparison path goes through hashToken — currentUser (session.ts:71), destroySession (:35), currentSessionKey (:49), and both changePassword (auth.ts:121) and revokeOtherSessions (auth.ts:137) exempt the current device by the hashed key, so the 'keep this device signed in' branch really matches a row. Expiry is enforced in SQL on every read.
- Constant-time password comparison: verifyPassword uses crypto.timingSafeEqual (crypto.ts:189), and the candidate is derived with keylen = expected.length, so the two buffers can never differ in length and make timingSafeEqual throw. The unknown-address path hashes against a cached decoy of identical cost (crypto.ts:198-202, auth.ts:80); the repo's own timing test passes (230/230 tests green).
- Randomness: grepped all of src/ and public/ — every random value comes from node:crypto (randomBytes, randomUUID). There is no Math.random anywhere in the application. OAuth state is 24 random bytes, single-use (deleted before validation), bound to user_id + provider and expired at 15 minutes (start/route.ts:30-40, callback/route.ts:35-41); the PKCE verifier is 48 random bytes with an S256 challenge.
- No secret reaches the client: grepped .next/static for SESSION_SECRET, CRON_SECRET and VAPID_PRIVATE_KEY, and for any `process.env.*` reference at all — nothing. crypto.ts is server-only.
- Decryption failures never leak their detail to a client: DecryptionError is not a UserFacingError, so errorResponse answers a plain 500 (api.ts:74-80); failureReason maps it to the fixed string 'needs reconnecting' before it is frozen into daily_feeds.items_json (connections.ts:191-202); credentialConnectError never quotes an upstream reply.
- Provider access tokens are passed in the query string by facebook.ts:70,89, threads.ts:70,84,91 and instagram.ts:72,76,91, but ProviderHttpError's message is `${provider} API responded ${status}: ${body.slice(0,200)}` (providers/http.ts:38) — provider, status and response body only, never the request URL — so a failed call does not write a live token into the operator's log via connections.ts:272 or callback/route.ts:51.
- Account export excludes token material: the SELECT names columns explicitly and omits access_token/refresh_token (export/route.ts:17-19). Account deletion clears every user-scoped table and relies on ON DELETE CASCADE (with PRAGMA foreign_keys=ON, db.ts:159) for push_subscriptions.
- Web Push key material (p256dh, auth) is stored in plaintext, which is inherent to Web Push and useless without the VAPID private key; that key lives only in the environment and never in the database. public/sw.js takes its notificationclick target from the push payload, but only a holder of the matching VAPID private key can produce a payload for a given subscription, so the openWindow target is not attacker-reachable.
- Already recorded in REVIEW.md and still unfixed, so not re-raised as new: SEC-10 (scrypt at Node defaults — measured 50.8 ms per guess, N=16384/r=8/p=1, 16-byte random salt, 64-byte output, below OWASP's N=2^17) and SEC-11 (CRON_SECRET compared with !== at cron/notify/route.ts:16 and cron/prewarm/route.ts:18 — a remote timing attack on a V8 string compare over HTTP is not practical). Worth noting alongside SEC-11 for another lens: neither cron route is rate-limited and CRON_SECRET has no minimum-length check at boot, unlike SESSION_SECRET, so a short one is brute-forceable at request speed.
- PREVIOUS_SESSION_SECRETS handling: entries are trimmed and filtered to >= 16 characters (crypto.ts:40-45) and each is tried by key id, not guessed; new writes always use the current key. The legacy 3-part path tries each key in turn and both of its failure branches throw the same message, so it reveals nothing about which key was configured.
- Ran the repository's own suite: 21 files, 230 tests, all passing, including test/crypto.test.ts's round-trip, key-id, rotation and tamper cases.

