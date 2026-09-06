import { signUp } from "@/lib/auth";
import { errorResponse, json, readJson } from "@/lib/api";
import { createSession } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const body = await readJson<{ email?: string; displayName?: string; password?: string; timezone?: string }>(req);
    const user = signUp({
      email: body.email ?? "",
      displayName: body.displayName ?? "",
      password: body.password ?? "",
      timezone: body.timezone,
    });
    await createSession(user.id);
    return json({ id: user.id, email: user.email, displayName: user.display_name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
