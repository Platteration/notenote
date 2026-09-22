#!/usr/bin/env bash
# The end-to-end run, self-contained: build the app, serve it on a database of its own, walk
# scripts/smoke.sh against it, and stop it again. `npm run test:e2e` is the whole thing, and
# CI runs exactly this rather than a copy of the steps.
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
fi
export DATA_DIR

LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  status=$?
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "--- server log ---" >&2
    cat "$LOG" >&2 || true
  fi
  rm -f "$LOG"
  [ -z "$SCRATCH_DATA_DIR" ] || rm -rf "$SCRATCH_DATA_DIR"
}
trap cleanup EXIT

npm run build

# `next start` serves in the process it is started in, so this PID is the server itself.
node node_modules/next/dist/bin/next start > "$LOG" 2>&1 &
SERVER_PID=$!

ready=""
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/health" > /dev/null; then ready=yes; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "the server exited before it answered" >&2; exit 1; fi
  sleep 1
done
[ -n "$ready" ] || { echo "the server did not answer /api/health within 60 seconds" >&2; exit 1; }

BASE="http://localhost:$PORT" bash scripts/smoke.sh
