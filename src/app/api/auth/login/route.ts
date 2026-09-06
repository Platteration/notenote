import { signIn } from "@/lib/auth";
import { errorResponse, json, readJson } from "@/lib/api";
import { createSession } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const body = await readJson<{ email?: string; password?: string }>(req);
    const user = signIn(body.email ?? "", body.password ?? "");
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    return errorResponse(err, 401);
  }
}
