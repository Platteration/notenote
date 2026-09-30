/**
 * DELETE /api/account — permanently delete the signed-in account and everything attached to
 * it, the archive included. What goes is listed in deleteAccountData (src/lib/account-data.ts).
 */
import { json, readJson, withUser } from "@/lib/api";
import { deleteAccountData } from "@/lib/account-data";
import { destroySession } from "@/lib/session";

export const DELETE = withUser(async (req, user) => {
  const body = await readJson<{ confirm?: string }>(req).catch(() => ({ confirm: undefined }));
  if (body.confirm !== user.email) {
    return json({ error: "Type your email address to confirm deletion" }, { status: 400 });
  }
  deleteAccountData(user.id);
  await destroySession();
  return json({ deleted: true });
});
