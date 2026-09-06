import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "./session";
import type { UserRow } from "./db";

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

export function errorResponse(err: unknown, fallbackStatus = 400): NextResponse {
  if (err instanceof UnauthorizedError) return json({ error: "Not signed in" }, { status: 401 });
  const message = err instanceof Error ? err.message : "Something went wrong";
  return json({ error: message }, { status: fallbackStatus });
}

/** Wrap a handler that needs a signed-in user. */
export function withUser<Ctx>(
  handler: (req: Request, user: UserRow, ctx: Ctx) => Promise<NextResponse> | NextResponse,
): (req: Request, ctx: Ctx) => Promise<NextResponse> {
  return async (req, ctx) => {
    try {
      const user = await requireUser();
      return await handler(req, user, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Request body must be JSON");
  }
}
