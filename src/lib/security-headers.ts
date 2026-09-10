/**
 * The security headers every response carries, and the policy inside them.
 *
 * These are pure functions of an environment so that the proxy (`src/proxy.ts`) can compute
 * them per request, and so a test can ask for a deployment shape it is not running in.
 */
type Env = Record<string, string | undefined>;

/**
 * The content security policy.
 *
 * No XSS sink exists here today — nothing calls dangerouslySetInnerHTML or innerHTML, and
 * every permalink is either built from a fixed https prefix or comes from a platform API — so
 * this is defence in depth for the day one appears. What it does carry today is
 * `frame-ancestors 'none'`: the Settings page has single-click buttons for signing other
 * devices out and disconnecting platforms, which is exactly what a clickjacking frame wants.
 *
 * Two loosenings are deliberate. `'unsafe-inline'` for scripts is what an app without a nonce
 * needs, since the framework inlines its bootstrap and hydration data; tightening it means a
 * nonce minted per request and handed to the renderer, which the proxy this policy is emitted
 * from could now do, but that is a change of its own. Images and media allow any https origin
 * because thumbnails and videos come from whichever CDN the connected platform uses, and
 * `data:` because demo thumbnails are inline SVG.
 */
export function contentSecurityPolicy(env: Env = process.env): string {
  const dev = env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    "img-src 'self' https: data:",
    "media-src 'self' https: blob:",
    // React refresh compiles in the browser during `next dev`; a built server never needs eval.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // The dev server's hot-reload socket; in production the app only calls its own API.
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Headers every response carries.
 *
 * HSTS is sent only when the deployment says it answers on https (`APP_BASE_URL`): a browser
 * is required to ignore it over plain http, but announcing a year of https-only for
 * `localhost` would be a poor way to find that out.
 *
 * That decision has to be made against the environment of the *running* server, which is why
 * this is called from the proxy rather than from `headers()` in next.config. A config
 * `headers()` entry is evaluated once during `next build` and frozen into
 * `.next/routes-manifest.json`, so a deployment that builds in CI or a Docker image and
 * supplies `APP_BASE_URL` only at `npm start` — the shape .env.example and the README
 * describe — would have got whatever the build machine's environment said, in both
 * directions: no HSTS for an https deployment, and a year of it announced over plain http
 * from an image built with an https base URL.
 */
export function securityHeaders(env: Env = process.env): Array<{ key: string; value: string }> {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  ];
  if ((env.APP_BASE_URL ?? "").startsWith("https://")) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}
