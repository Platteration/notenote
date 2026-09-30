/**
 * DELETE /api/settings/prefs — put the appearance and feedback preferences back to their
 * defaults. Only that record: the hour, connections, history and the shelf are untouched.
 * The confirmation happens in the page; here it is one authenticated, same-site request.
 */
import { json, withUser } from "@/lib/api";
import { resetPrefs } from "@/lib/settings";

export const DELETE = withUser(async (_req, user) => json({ prefs: resetPrefs(user.id).prefs }));
