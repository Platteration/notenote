/**
 * GET /api/account/export — everything the app holds about you, as a JSON download. What it
 * contains, and what it deliberately leaves out, is described on buildExport.
 */
import { withUser } from "@/lib/api";
import { buildExport } from "@/lib/account-data";

export const GET = withUser(async (_req, user) => {
  return new Response(JSON.stringify(buildExport(user), null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="daily-scroll-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
