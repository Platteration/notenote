#!/usr/bin/env bash
# End-to-end smoke test against a running server: the shortest path that proves the
# product works — an account, a connection, an open hour with a real curated feed, and
# a locked hour outside it.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

api() { curl -sS -b "$JAR" -c "$JAR" -H "Content-Type: application/json" "$@"; }
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "-> the server says it is up, to anyone, and says nothing else"
health="$(curl -sS "$BASE/api/health")"
case "$health" in *'"ok":true'*) ;; *) fail "health did not answer ok: $health" ;; esac
node -e '
  const body = JSON.parse(process.argv[1]);
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "ok,version") throw new Error("health answered more than ok and version: " + keys);
' "$health"

echo "-> the feed is private"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "401" ] || fail "feed was readable without signing in"

# The default hour opens at 20:00 in the user's own zone, so a walk signed up in UTC found it
# open from 20:00 to 20:59 UTC and failed "shut by default" every day in that hour. The walk
# signs up where it is not within an hour of 20:00: UTC, except from 19:00 to 20:59 UTC, when
# Asia/Tokyo (UTC+9, no daylight saving) reads 04:00 to 05:59. Every clock time the walk sets
# later is read in the same zone.
case "$(date -u +%H)" in 19|20) ZONE="Asia/Tokyo" ;; *) ZONE="UTC" ;; esac

echo "-> sign up (timezone $ZONE)"
api -X POST "$BASE/api/auth/signup" \
  -d "{\"email\":\"smoke@example.com\",\"displayName\":\"Smoke\",\"password\":\"password123\",\"timezone\":\"$ZONE\"}" \
  -o /dev/null || fail "signup"

echo "-> the hour is shut by default"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "423" ] || fail "expected the scroll to be locked"

echo "-> connect two platforms in demo mode"
for p in youtube reddit; do
  api -o /dev/null -X POST "$BASE/api/connect/$p" || fail "connect $p"
done

echo "-> open the hour now"
NOW_HM="$(TZ="$ZONE" date +%H:%M)"
api -X PUT "$BASE/api/settings" -d "{\"windowStart\":\"$NOW_HM\",\"feedSize\":20}" -o /dev/null || fail "settings"

echo "-> the feed is curated and balanced"
api "$BASE/api/feed" > /tmp/smoke-feed.json
node -e '
  const feed = require("/tmp/smoke-feed.json");
  if (feed.status !== "open") throw new Error("feed is not open: " + feed.status);
  if (!feed.items.length) throw new Error("feed is empty");
  const providers = new Set(feed.items.map((i) => i.provider));
  if (providers.size < 2) throw new Error("expected both platforms, saw " + [...providers]);
  const tooLong = feed.items.filter((i) => i.durationSeconds != null && i.durationSeconds > 90);
  if (tooLong.length) throw new Error(tooLong.length + " clips exceeded short-form length");
  console.log("   " + feed.items.length + " clips from " + [...providers].join(", "));
'

echo "-> save a clip, then find it on the shelf"
KEY="$(node -e 'console.log(require("/tmp/smoke-feed.json").items[0].key)')"
api -X POST "$BASE/api/saved" -d "{\"key\":\"$KEY\"}" -o /dev/null || fail "save"
api "$BASE/api/saved" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    if (JSON.parse(s).saved.length !== 1) throw new Error("clip was not on the shelf");
  });
'

echo "-> a clip from another feed cannot be saved"
[ "$(api -o /dev/null -w '%{http_code}' -X POST "$BASE/api/saved" -d '{"key":"youtube:not-mine"}')" = "400" ] \
  || fail "accepted a clip that was not in the user's feed"

echo "-> the archive: a note, a collection, search, and a removal that asks first"
status() { api -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$1" = "$2" ] || fail "$3 (got $1, expected $2)"; }
json_field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
expect "$(status -X PATCH "$BASE/api/saved/note" -d "{\"key\":\"$KEY\",\"note\":\"watch with Sam\"}")" 200 "note"
expect "$(status -X PATCH "$BASE/api/saved/note" -d '{"key":"youtube:not-mine","note":"x"}')" 404 "a note on a clip that is not in the archive"
COL="$(api -X POST "$BASE/api/collections" -d '{"name":"Cooking"}' | json_field collection.id)"
[ -n "$COL" ] || fail "collection was not created"
expect "$(status -X POST "$BASE/api/collections" -d '{"name":"cooking"}')" 400 "a second collection with the same name"
expect "$(status -X PATCH "$BASE/api/collections/$COL" -d '{"name":"Dinner ideas"}')" 200 "rename"
expect "$(status -X PATCH "$BASE/api/collections/nope" -d '{"name":"x"}')" 404 "rename of an unknown collection"
expect "$(status -X POST "$BASE/api/collections/$COL/items" -d '{}')" 400 "filing without a clip"
expect "$(status -X POST "$BASE/api/collections/nope/items" -d "{\"key\":\"$KEY\"}")" 404 "filing into an unknown collection"
expect "$(status -X POST "$BASE/api/collections/$COL/items" -d "{\"key\":\"$KEY\"}")" 200 "file the clip"
[ "$(api "$BASE/api/saved?q=with%20sam" | json_field saved.length)" = "1" ] || fail "search by note found nothing"
[ "$(api "$BASE/api/saved?q=dinner" | json_field saved.length)" = "1" ] || fail "search by collection name found nothing"
[ "$(api "$BASE/api/saved?q=zzz-no-match" | json_field saved.length)" = "0" ] || fail "a search matched nothing and still returned clips"
[ "$(api "$BASE/api/saved?collection=$COL" | json_field saved.length)" = "1" ] || fail "the collection filter lost the clip"
expect "$(status "$BASE/api/saved?collection=nope")" 404 "search in an unknown collection"
expect "$(status -X DELETE "$BASE/api/collections/$COL/items?key=$KEY")" 200 "take the clip out of the collection"
expect "$(status -X POST "$BASE/api/collections/$COL/items" -d "{\"key\":\"$KEY\"}")" 200 "file it again"
expect "$(status -X DELETE "$BASE/api/saved?key=$KEY")" 409 "removing a clip with a note did not ask first"
[ "$(api "$BASE/api/saved" | json_field saved.0.note)" = "watch with Sam" ] || fail "the refused removal lost the note"
expect "$(status -X DELETE "$BASE/api/collections/$COL")" 200 "delete the collection"
expect "$(status -X DELETE "$BASE/api/collections/$COL")" 404 "delete it twice"
[ "$(api "$BASE/api/saved" | json_field saved.0.note)" = "watch with Sam" ] || fail "deleting a collection lost the clip's note"
expect "$(status -X DELETE "$BASE/api/saved?key=$KEY&confirm=1")" 200 "a confirmed removal"
[ "$(api "$BASE/api/saved" | json_field saved.length)" = "0" ] || fail "the confirmed removal left the clip"

echo "-> close the hour and confirm it locks again"
PAST_HM="$(TZ="$ZONE" date -d '-2 hours' +%H:%M 2>/dev/null || TZ="$ZONE" date -v-2H +%H:%M)"
api -X PUT "$BASE/api/settings" -d "{\"windowStart\":\"$PAST_HM\"}" -o /dev/null || fail "settings"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "423" ] || fail "the scroll stayed open past its hour"

echo "-> preferences reset to their defaults and touch nothing else"
api -X PUT "$BASE/api/settings" -d '{"prefs":{"theme":"wire","reduceMotion":"off","accent":"sky"}}' -o /dev/null || fail "prefs"
# The page carries the choice, so the stylesheet can honour it before any script runs.
page="$(api "$BASE/settings")"
case "$page" in *'data-reduce-motion="false"'*) ;; *) fail "the settings page did not carry the reduce-motion choice" ;; esac
# Every picker swatch carries data-accent too, so this looks at the <html> tag alone.
printf '%s' "$page" | grep -o '<html[^>]*>' | grep -q 'data-accent="sky"' || fail "the page did not carry the chosen accent on <html>"
[ "$(api -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/settings" -d '{"prefs":{"accent":"neon"}}')" = "400" ] \
  || fail "an unknown accent was accepted"
api -X DELETE "$BASE/api/settings/prefs" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const { prefs } = JSON.parse(s);
    if (prefs.theme !== "system" || prefs.reduceMotion !== "system" || prefs.accent !== "apricot") throw new Error("prefs were not reset: " + s);
  });
'
api "$BASE/settings" | grep -o '<html[^>]*>' | grep -q 'data-accent=' && fail "the default accent still wrote data-accent on <html>"
api "$BASE/api/settings" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const { settings } = JSON.parse(s);
    if (settings.windowStart !== process.argv[1] || settings.feedSize !== 20) throw new Error("the reset touched the hour: " + s);
  });
' "$PAST_HM"

echo "-> wrong passwords are rejected, and throttled where the client can be identified"
# Per-address throttling only runs when a trusted proxy names the client, so the forwarding
# header below counts for something only if the server was started with TRUSTED_PROXY_HOPS=1.
# Without one the address-keyed buckets are deliberately skipped: sharing a single bucket
# would let a stranger lock sign-in for the whole deployment.
codes=""
for _ in $(seq 1 10); do
  codes="$codes$(curl -sS -o /dev/null -w '%{http_code} ' -H 'Content-Type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.250' -X POST "$BASE/api/auth/login" \
    -d '{"email":"smoke@example.com","password":"wrong"}')"
done
case "$codes" in
  *429*) echo "   throttled after a few attempts" ;;
  *401*) echo "   all attempts rejected; per-address throttling is off (set TRUSTED_PROXY_HOPS)" ;;
  *) fail "wrong passwords were not rejected: $codes" ;;
esac

echo "-> a cross-site form post cannot sign anyone in"
csrf="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' \
  -H 'Sec-Fetch-Site: cross-site' -H "Origin: https://evil.example" -X POST "$BASE/api/auth/login" \
  -d '{"email":"smoke@example.com","password":"password123","x":"="}')"
[ "$csrf" = "403" ] || fail "a cross-site sign-in was not refused: $csrf"

echo "-> every response carries the security headers"
# Only a running server proves this: the unit test checks what the policy says, this checks
# that a real response actually carries it.
hdrs="$(curl -sSI "$BASE/")"
case "$hdrs" in *"frame-ancestors 'none'"*) ;; *) fail "no Content-Security-Policy with frame-ancestors" ;; esac
case "$hdrs" in *nosniff*) ;; *) fail "no X-Content-Type-Options" ;; esac
case "$hdrs" in *[Xx]-[Pp]owered-[Bb]y*) fail "X-Powered-By is still advertised" ;; esac
# HSTS is decided by the running server's APP_BASE_URL, not by the machine that built it, so
# it has to agree with the address this script is actually talking to. Over plain http it must
# be absent: a build with an https base URL frozen into it would announce a year of https-only
# to a deployment that cannot answer on https.
hsts=""
case "$hdrs" in *[Ss]trict-[Tt]ransport-[Ss]ecurity*) hsts="yes" ;; esac
case "$BASE" in
  https://*) [ -n "$hsts" ] || fail "an https deployment sent no Strict-Transport-Security" ;;
  *) [ -z "$hsts" ] || fail "HSTS was announced over plain http (a build-time value, or APP_BASE_URL disagrees with $BASE)" ;;
esac

echo "-> the repository's own files are not part of the site"
# The server answers its routes and public/, nothing else: not the sources, the configuration,
# the git metadata or the build's internals, and not by a path that climbs out of public/ or
# /_next/static either (--path-as-is sends the dots and their encodings as written).
for path in /README.md /package.json /.env.example /.git/config /next.config.ts /src/proxy.ts \
  /scripts/e2e.sh /public/guard.js /_next/BUILD_ID /%2e%2e/package.json \
  /_next/static/..%2f..%2f..%2fpackage.json /_next/static/%2e%2e/%2e%2e/%2e%2e/package.json \
  /icons/..%2f..%2fpackage.json /.well-known/..%2f..%2fpackage.json; do
  code="$(curl -sS --path-as-is -o /tmp/smoke-file -w '%{http_code}' "$BASE$path")"
  [ "$code" = "404" ] || fail "$path answered $code"
  ! grep -qE '"name": "daily-scroll"|repositoryformatversion|SESSION_SECRET=|export function proxy|NextConfig' /tmp/smoke-file \
    || fail "$path served a file from the repository"
done

echo "-> an oversized body is refused rather than buffered"
big="$(printf '%070000d' 0 | tr '0' 'x')"
code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/auth/login" \
  -d "{\"email\":\"smoke@example.com\",\"password\":\"$big\"}")"
[ "$code" = "413" ] || fail "a 70 KB sign-in body was not refused: $code"

echo "SMOKE PASS"
