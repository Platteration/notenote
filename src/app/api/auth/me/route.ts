import { json } from "@/lib/api";
import { currentUser } from "@/lib/session";

export async function GET() {
  const user = await currentUser();
  if (!user) return json({ user: null });
  return json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
}
