#!/usr/bin/env bash
# The end-to-end run, self-contained: build the app, serve it on a database of its own, walk
# scripts/smoke.sh (the API, over HTTP) and then scripts/browser-walk.mjs (the pages, in
# Chromium, under the headers the server really sends) against it, and stop it again. Then a
# second server from the same build, with sign in with Google and the shop turned on and a fake
# Google and a fake Stripe loaded into its process (scripts/e2e-upstreams.mjs), for
# scripts/integrations-walk.mjs. The first server has neither turned on, as a deployment with no
# keys has not, and its walks check nothing about them is drawn.
# `npm run test:e2e` is the whole thing, and CI runs exactly this rather than a copy of the
# steps. The browser walk needs Playwright's Chromium: `npx playwright install chromium` once.
#
# The server is stopped by the PID recorded when it was started. Stopping it by name is how a
# run loses one: `pkill -f 'next start'` matches the shell running this script as well.
set -euo pipefail

cd "$(dirname "$0")/.."

# A free port, so a development server on 3000 is not what gets walked.
PORT="${PORT:-$(node -e 'const s = require("net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });')}"
export PORT
export SESSION_SECRET="${SESSION_SECRET:-e2e-secret-not-a-real-deployment-key}"

# A scratch DATA_DIR unless one is named: the walk signs up the same account every time, so it
# needs an empty app, and it must never be pointed at a real one.
SCRATCH_DATA_DIR=""
if [ -z "${DATA_DIR:-}" ]; then
  DATA_DIR="$(mktemp -d)"
  SCRATCH_DATA_DIR="$DATA_DIR"
  # Git Bash translates command arguments for Windows Node, but not environment values.
  if command -v cygpath >/dev/null 2>&1; then DATA_DIR="$(cygpath -w "$DATA_DIR")"; fi
fi
export DATA_DIR

LOG="$(mktemp)"
SERVER_PID=""
LOG2="$(mktemp)"
SERVER2_PID=""
DATA_DIR2="$(mktemp -d)"

cleanup() {
  status=$?
  for pid in "$SERVER_PID" "$SERVER2_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ "$status" -ne 0 ]; then
    echo "--- server log ---" >&2
    cat "$LOG" >&2 || true
    echo "--- server log (sign-in and shop on) ---" >&2
    cat "$LOG2" >&2 || true
  fi
  rm -f "$LOG" "$LOG2"
  [ -z "$SCRATCH_DATA_DIR" ] || rm -rf "$SCRATCH_DATA_DIR"
  rm -rf "$DATA_DIR2"
}
trap cleanup EXIT

# Wait for a server to answer /api/health, or say why it never did.
await_health() {
  local port="$1" pid="$2"
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$port/api/health" > /dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "the server on $port exited before it answered" >&2; exit 1; fi
    sleep 1
  done
  echo "the server on $port did not answer /api/health within 60 seconds" >&2
  exit 1
}

npm run build

# `next start` serves in the process it is started in, so this PID is the server itself.
node node_modules/next/dist/bin/next start > "$LOG" 2>&1 &
SERVER_PID=$!

await_health "$PORT" "$SERVER_PID"

BASE="http://localhost:$PORT" bash scripts/smoke.sh
BASE="http://localhost:$PORT" node scripts/browser-walk.mjs

# The second server: sign in with Google and the shop on, with the test credentials the fakes
# expect, its own scratch database, and APP_BASE_URL naming the address the walk uses (an
# http://localhost base is the one plain-http address sign-in accepts).
PORT2="$(node -e 'const s = require("net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });')"
DATA_DIR2_FOR_NODE="$DATA_DIR2"
if command -v cygpath >/dev/null 2>&1; then DATA_DIR2_FOR_NODE="$(cygpath -w "$DATA_DIR2")"; fi
(
  eval "$(node scripts/e2e-fakes.mjs --env)"
  export PORT="$PORT2" DATA_DIR="$DATA_DIR2_FOR_NODE" APP_BASE_URL="http://localhost:$PORT2"
  exec node --import ./scripts/e2e-upstreams.mjs node_modules/next/dist/bin/next start
) > "$LOG2" 2>&1 &
SERVER2_PID=$!
await_health "$PORT2" "$SERVER2_PID"

BASE="http://localhost:$PORT2" node scripts/integrations-walk.mjs
