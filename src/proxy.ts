/**
 * Security headers, applied to every response as it is answered.
 *
 * This is the `proxy.ts` file convention (Next 16 renamed `middleware.ts` to it); with no
 * `matcher` it runs for every request — pages, API routes, `/_next/static` assets, files from
 * `public/` and the not-found page alike — which is the coverage the previous `/:path*` entry in
 * next.config had.
 *
 * It lives here rather than in `headers()` in next.config because a config `headers()` entry
 * is evaluated once during `next build` and baked into `.next/routes-manifest.json` — the
 * production server reads the manifest, not the config — so anything decided from the
 * environment would have frozen the build machine's answer. `Strict-Transport-Security` and
 * `upgrade-insecure-requests` vary that way, and the script nonce varies per request, which no
 * build-time entry can do at all. Here every header is computed from the environment of the
 * process actually serving the request.
 *
 * The nonce: the policy allows no inline script except one carrying this request's nonce. The
 * framework inlines its bootstrap and the page's flight data as `<script>` elements, and it
 * reads the nonce back out of the `Content-Security-Policy` *request* header while it renders
 * and stamps it on every script it writes. So the policy goes on the request as well as on the
 * response, overwriting whatever the client sent under that name: the nonce in the page is
 * always the one this function minted. (`next start` also copies a proxy's response headers
 * onto the request, so the response header alone happens to reach the renderer there; handing
 * it over explicitly is what the framework documents, and does not lean on that copy.) Every
 * page is rendered per request already — the root layout reads the session cookie — which is
 * what a nonce needs; a prerendered page could not carry one.
 *
 * `process.env` is passed as an object rather than read as `process.env.APP_BASE_URL` so that
 * nothing can be substituted for it at build time.
 *
 * The cost of this file existing: Next clones and buffers every request body so that a proxy
 * and a route handler can both read it, before any handler runs. `next.config.ts` caps that at
 * 128 KB (`experimental.proxyClientMaxBodySize`) so it cannot outrun `MAX_REQUEST_BYTES`;
 * without the cap the framework's own 10 MB default applies to every unauthenticated request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { newNonce, securityHeaders } from "@/lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const headers = securityHeaders(process.env, newNonce());
  const forwarded = new Headers(request.headers);
  for (const { key, value } of headers) {
    if (key === "Content-Security-Policy") forwarded.set(key, value);
  }
  const res = NextResponse.next({ request: { headers: forwarded } });
  for (const { key, value } of headers) res.headers.set(key, value);
  return res;
}
