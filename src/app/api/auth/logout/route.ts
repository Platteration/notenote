import { assertSameSite, errorResponse, json } from "@/lib/api";
import { destroySession } from "@/lib/session";

export async function POST(req: Request) {
  try {
    assertSameSite(req);
  } catch (err) {
    return errorResponse(err);
  }
  await destroySession();
  return json({ ok: true });
}
