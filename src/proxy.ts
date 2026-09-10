/**
 * Security headers, applied to every response as it is answered.
 *
 * This is the `proxy.ts` file convention (Next 16 renamed `middleware.ts` to it); with no
 * `matcher` it runs for every request, which is the coverage the previous `/:path*` entry in
 * next.config had.
 *
 * It lives here rather than in `headers()` in next.config because a config `headers()` entry
 * is evaluated once during `next build` and baked into `.next/routes-manifest.json` — the
 * production server reads the manifest, not the config — so anything decided from the
 * environment would have frozen the build machine's answer. Only `Strict-Transport-Security`
 * varies that way today, but it is the one that matters: a build in CI or a Docker image with
 * `APP_BASE_URL` supplied at `npm start` would never have sent it. Here every header is
 * computed from the environment of the process actually serving the request.
 *
 * `process.env` is passed as an object rather than read as `process.env.APP_BASE_URL` so that
 * nothing can be substituted for it at build time.
 */
import { NextResponse } from "next/server";
import { securityHeaders } from "@/lib/security-headers";

export function proxy(): NextResponse {
  const res = NextResponse.next();
  for (const { key, value } of securityHeaders(process.env)) res.headers.set(key, value);
  return res;
}
