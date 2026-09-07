/**
 * POST /api/cron/prewarm   (Authorization: Bearer $CRON_SECRET)
 *
 * Fetches fresh items from every live platform for users whose hour opens within the
 * next `PREWARM_MINUTES` (default 30), so the first request inside the window is served
 * from cache instead of waiting on five APIs. Safe to run every 15 minutes; the README
 * has the crontab line.
 */
import { json } from "@/lib/api";
import { collectItems } from "@/lib/connections";
import { getDb, now } from "@/lib/db";
import { purgeExpired, windowFor } from "@/lib/feed";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, { status: 401 });

  const horizonMs = Number(process.env.PREWARM_MINUTES ?? 30) * 60 * 1000;
  const at = now();
  // This runs on a schedule, so it is the reliable place to sweep expired rows.
  const purged = purgeExpired(at);
  const users = getDb()
    .prepare("SELECT DISTINCT user_id FROM connections WHERE demo = 0")
    .all() as Array<{ user_id: string }>;

  const warmed: Array<{ userId: string; providers: number; errors: string[] }> = [];
  for (const { user_id } of users) {
    const win = windowFor(user_id, at);
    const opensSoon = !win.isOpen && win.opensAt - at <= horizonMs;
    if (!opensSoon && !win.isOpen) continue;
    const results = await collectItems(user_id, at);
    warmed.push({
      userId: user_id,
      providers: results.length,
      errors: results.filter((r) => r.error).map((r) => `${r.provider}: ${r.error}`),
    });
  }
  return json({ checked: users.length, warmed: warmed.length, purged, details: warmed });
}
