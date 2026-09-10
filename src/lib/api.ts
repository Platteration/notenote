import { NextResponse } from "next/server";
import { UserFacingError } from "./errors";
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

/**
 * Answer an error without describing the inside of the server.
 *
 * Only a `UserFacingError` carries a message a client should see. Anything else — a SQLite
 * constraint, a JSON.parse failure, a decrypt that could not authenticate its data, a
 * platform's HTTP error with part of the upstream body in it — is logged here and answered
 * with a 500 and nothing else. `fallbackStatus` still applies to user-facing errors that do
 * not name a status of their own, which is how a bad sign-in stays a 401.
 */
export function errorResponse(err: unknown, fallbackStatus = 400): NextResponse {
  if (err instanceof UnauthorizedError) return json({ error: "Not signed in" }, { status: 401 });
  if (err instanceof CrossSiteError) return json({ error: err.message }, { status: 403 });
  if (err instanceof UserFacingError) return json({ error: err.message }, { status: err.status ?? fallbackStatus });
  console.error("Unhandled error while answering a request:", err);
  return json({ error: "Something went wrong" }, { status: 500 });
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

/**
 * How much request body is read before it is refused.
 *
 * Every legitimate request here is a small JSON object — a sign-in, a settings change, a list
 * of at most 200 clip keys — so this is orders of magnitude above anything the app sends. A
 * route handler gets no body limit from the framework, so without this an unauthenticated
 * client can make the server buffer as much as it cares to send, on a route that parses
 * before it throttles.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Read a body through a counting stream rather than req.json().
 *
 * Content-Length cannot be the guard: it is absent under chunked transfer encoding, which is
 * exactly what a client sending an unbounded body would use. It is still worth an early
 * refusal when it is present and already too large.
 */
async function readCappedBody(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new UserFacingError("Request body is too large", 413);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new UserFacingError("Request body is too large", 413);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

export async function readJson<T>(req: Request, limit = MAX_REQUEST_BYTES): Promise<T> {
  // A cross-site form can only post text/plain, multipart or urlencoded, so insisting on
  // JSON here is a second, independent guard on the same hole as assertSameSite.
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new UserFacingError("Request body must be JSON");
  }
  const text = await readCappedBody(req, limit);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UserFacingError("Request body must be JSON");
  }
}
