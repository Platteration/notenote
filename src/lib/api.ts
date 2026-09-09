import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "./session";
import type { UserRow } from "./db";

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

/**
 * A request that a browser made from somewhere other than this app.
 *
 * Sign-in and sign-up need no existing cookie, so SameSite=Lax cannot protect them: Lax
 * decides whether a cookie is *sent*, and those routes *set* one. A cross-site
 * `<form enctype="text/plain">` whose single field name carries a JSON prefix produces a
 * body that req.json() accepts, so without this check another site can sign a visitor into
 * an account it controls — and then read whatever platforms they go on to connect.
 */
export class CrossSiteError extends Error {
  constructor() {
    super("Cross-site request refused");
    this.name = "CrossSiteError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin this deployment answers on, when it is configured. */
function configuredOrigin(): string | null {
  const base = process.env.APP_BASE_URL;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * Refuse a state-changing request that a browser initiated from another site.
 *
 * Sec-Fetch-Site is the reliable signal and no page can forge it, so it decides on its own
 * when present. When it is absent — a script, curl, the cron job, a browser too old to send
 * it — an Origin that disagrees with this deployment is still refused; no header at all is
 * allowed through, because a cross-site form always sends one of the two.
 */
export function assertSameSite(req: Request): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    if (site !== "same-origin" && site !== "none") throw new CrossSiteError();
    return;
  }
  const origin = req.headers.get("origin");
  if (!origin) return;
  let expected: string;
  try {
    expected = configuredOrigin() ?? new URL(req.url).origin;
  } catch {
    throw new CrossSiteError();
  }
  if (origin !== expected) throw new CrossSiteError();
}

export function errorResponse(err: unknown, fallbackStatus = 400): NextResponse {
  if (err instanceof UnauthorizedError) return json({ error: "Not signed in" }, { status: 401 });
  if (err instanceof CrossSiteError) return json({ error: err.message }, { status: 403 });
  const message = err instanceof Error ? err.message : "Something went wrong";
  return json({ error: message }, { status: fallbackStatus });
}

/** Wrap a handler that needs a signed-in user. Handlers may return any Response (e.g. a file download). */
export function withUser<Ctx>(
  handler: (req: Request, user: UserRow, ctx: Ctx) => Promise<Response> | Response,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      assertSameSite(req);
      const user = await requireUser();
      return await handler(req, user, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  // A cross-site form can only post text/plain, multipart or urlencoded, so insisting on
  // JSON here is a second, independent guard on the same hole as assertSameSite.
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new Error("Request body must be JSON");
  }
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Request body must be JSON");
  }
}
