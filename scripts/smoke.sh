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

echo "-> the feed is private"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "401" ] || fail "feed was readable without signing in"

echo "-> sign up"
api -X POST "$BASE/api/auth/signup" \
  -d '{"email":"smoke@example.com","displayName":"Smoke","password":"password123","timezone":"UTC"}' \
  -o /dev/null || fail "signup"

echo "-> the hour is shut by default"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "423" ] || fail "expected the scroll to be locked"

echo "-> connect two platforms in demo mode"
for p in youtube reddit; do
  api -o /dev/null -X POST "$BASE/api/connect/$p" || fail "connect $p"
done

echo "-> open the hour now"
NOW_HM="$(date -u +%H:%M)"
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

echo "-> close the hour and confirm it locks again"
PAST_HM="$(date -u -d '-2 hours' +%H:%M 2>/dev/null || date -u -v-2H +%H:%M)"
api -X PUT "$BASE/api/settings" -d "{\"windowStart\":\"$PAST_HM\"}" -o /dev/null || fail "settings"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/feed")" = "423" ] || fail "the scroll stayed open past its hour"

echo "-> sign-in throttling is active"
codes=""
for _ in $(seq 1 10); do
  codes="$codes$(curl -sS -o /dev/null -w '%{http_code} ' -H 'Content-Type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.250' -X POST "$BASE/api/auth/login" \
    -d '{"email":"smoke@example.com","password":"wrong"}')"
done
case "$codes" in *429*) ;; *) fail "brute force was not throttled: $codes" ;; esac

echo "SMOKE PASS"
