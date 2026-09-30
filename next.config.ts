import type { NextConfig } from "next";

/**
 * Deliberately no `headers()` here.
 *
 * `headers()` is evaluated once during `next build` and written into
 * `.next/routes-manifest.json`; the production server serves the manifest and never consults
 * this file for them again. Security headers that depend on how the deployment is run — HSTS
 * reads `APP_BASE_URL` — would therefore have carried the build machine's environment.
 * They are emitted per request from `src/proxy.ts` instead; the policy itself lives in
 * `src/lib/security-headers.ts`.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Nothing gains from telling every client which framework and version this is.
  poweredByHeader: false,
  experimental: {
    /**
     * How much of a request body the framework buffers before any handler runs.
     *
     * Having a `proxy.ts` at all makes Next clone and buffer every request body so that both
     * the proxy and the route handler can read it, and the default ceiling for that is 10 MB.
     * That buffering happens *before* the handler is entered, so it is ahead of
     * `MAX_REQUEST_BYTES` (64 KB), the sign-in rate limit and `assertSameSite` — an
     * unauthenticated client could pin megabytes per connection on a route that would have
     * refused it. The two limits have to agree; this is the same 64 KB with one doubling of
     * head-room, because an over-limit body is *truncated* here rather than refused, and
     * `readCappedBody` should still be the thing that sees too many bytes and answers 413.
     */
    proxyClientMaxBodySize: "128kb",
  },
};

export default nextConfig;
