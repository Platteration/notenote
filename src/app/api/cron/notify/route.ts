/**
 * POST /api/cron/notify   (Authorization: Bearer $CRON_SECRET)
 *
 * Sends the one daily notification to anyone whose hour is open right now and who has not
 * already been told today. Run it every minute or two; it is idempotent per local day.
 */
import { json } from "@/lib/api";
import { windowFor } from "@/lib/feed";
import { now } from "@/lib/db";
import { notifyHourOpen, pushConfigured, subscribedUserIds } from "@/lib/push";
import { WINDOW_MINUTES } from "@/lib/window";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) return json({ error: "VAPID keys are not configured" }, { status: 503 });

  const at = now();
  const totals = { sent: 0, removed: 0, failed: 0 };
  let open = 0;
  for (const userId of subscribedUserIds()) {
    const win = windowFor(userId, at);
    if (!win.isOpen) continue;
    open++;
    const r = await notifyHourOpen(userId, win.dayKey, WINDOW_MINUTES);
    totals.sent += r.sent;
    totals.removed += r.removed;
    totals.failed += r.failed;
  }
  return json({ usersOpen: open, ...totals });
}
