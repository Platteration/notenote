/**
 * GET /api/health — liveness for a container or uptime check.
 *
 * `{ ok, version }` and nothing else. No session, so a checker needs no cookie: this file is
 * deliberately not wrapped in `withUser`, which is the only gate a route has here (the proxy
 * sets headers and never refuses). And no database path, data directory or environment,
 * because the answer is readable by whoever can reach the port.
 */
import { json } from "@/lib/api";
import { APP_VERSION } from "@/lib/version";

export function GET() {
  return json({ ok: true, version: APP_VERSION });
}
