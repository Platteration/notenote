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
};

export default nextConfig;
