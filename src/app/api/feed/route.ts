/**
 * GET /api/feed
 * 200 with the curated items while the daily hour is open; 423 Locked otherwise.
 */
import { json, withUser } from "@/lib/api";
import { getFeed, purgeExpiredIfDue } from "@/lib/feed";

export const GET = withUser(async (_req, user) => {
  purgeExpiredIfDue();
  const feed = await getFeed(user.id);
  if (feed.status === "locked") return json(feed, { status: 423 });
  return json(feed);
});
