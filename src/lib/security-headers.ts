/**
 * The security headers every response carries, and the policy inside them.
 *
 * These are pure functions of an environment and a nonce so that the proxy (`src/proxy.ts`) can
 * compute them per request, and so a test can ask for a deployment shape it is not running in.
 * The README's headers block (under "The website: headers and hosting") writes the same values
 * out: `test/headers.test.ts` holds the two equal word for word, and the browser walk holds every
 * live response to the block.
 */
type Env = Record<string, string | undefined>;

/** Sixteen random bytes, base64: unguessable, and fresh for every response. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/** The deployment says it answers on https, which is what HSTS and the upgrade both promise. */
function servesHttps(env: Env): boolean {
  return (env.APP_BASE_URL ?? "").startsWith("https://");
}

/**
 * The content security policy.
 *
 * Nothing is allowed unless it is named, and every source below was measured: the browser walk
 * (`scripts/browser-walk.mjs`, part of `npm run test:e2e`) loads every page of the built app
 * under exactly this header and fails on any violation, so a source that something real needs
 * cannot be missing, and one added for nothing is a change someone has to explain.
 *
 * - Scripts: the app's own files, and an inline script only when it carries this response's
 *   nonce. The framework inlines its bootstrap and each page's flight data; `src/proxy.ts`
 *   hands it the nonce. No `'unsafe-inline'` and, outside `next dev`, no `'unsafe-eval'`.
 * - Styles: the app's own stylesheets. React writes `style` props as `style` attributes, and
 *   the components use them for values computed per item (a progress ring's percentage, a
 *   platform's brand colour), so `style-src-attr` allows inline attributes and nothing else: an
 *   injected `<style>` element, which can select and leak what the page shows, is still refused.
 * - Images and media allow any https origin, because thumbnails and videos come from whichever
 *   CDN the connected platform uses, and images allow `data:` because demo posters are inline
 *   SVG.
 * - Fonts: the display face, which `next/font` downloads at build time and serves from
 *   `/_next/static/media`.
 * - The service worker, the web manifest and `fetch` to the app's own API are same-origin.
 * - `base-uri 'none'` and `form-action 'none'`: no page sets a `<base>`, and every form is sent
 *   by its script, so the browser itself never submits one. An injected `<form>` cannot send
 *   what is typed into it (or what a password manager fills in) anywhere, and a form pressed
 *   before the page's scripts have run is refused instead of reloading the page and losing what
 *   was typed.
 * - `frame-ancestors 'none'`: the Settings page has single-click buttons for signing other
 *   devices out and disconnecting platforms, which is exactly what a clickjacking frame wants.
 * - `upgrade-insecure-requests` only where the deployment answers on https, like HSTS.
 */
export function contentSecurityPolicy(env: Env = process.env, nonce?: string): string {
  // `next dev` sets NODE_ENV=development and nothing else does, so the loosenings below are
  // asked for by name. Reading this as "anything that is not production" was safe while the
  // policy was frozen at build time, and is not now that it is decided per request: a built
  // server started with NODE_ENV=staging, or with the variable unset, would serve
  // `'unsafe-eval'` and `ws:` to real users.
  const dev = env.NODE_ENV === "development";
  const scripts = ["'self'"];
  if (nonce) scripts.push(`'nonce-${nonce}'`);
  // React refresh compiles in the browser during `next dev`; a built server never needs eval.
  if (dev) scripts.push("'unsafe-eval'");
  return [
    "default-src 'none'",
    `script-src ${scripts.join(" ")}`,
    // The development overlay injects its own <style> elements; a built server has none.
    `style-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' https: data:",
    "media-src https:",
    "font-src 'self'",
    // The dev server's hot-reload socket; in production the app only calls its own API.
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(servesHttps(env) ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The powerful features a page can ask the browser for, every one denied but `autoplay`, which
 * this origin keeps because a clip starts playing as it scrolls into view. Nothing in the app
 * reaches for any of the others, so an injected script cannot either. Vibration, Web Audio
 * chimes and notifications are not features this header governs. `interest-cohort` is FLoC,
 * long withdrawn, and `browsing-topics` its successor; Chromium still recognises both.
 *
 * Every name here is one the browser recognises (a misspelt feature is ignored without a
 * word): the browser walk reads `document.featurePolicy` and fails on a name it does not know
 * or a feature the page is still allowed.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=(self)",
  "browsing-topics=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "interest-cohort=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "window-management=()",
  "xr-spatial-tracking=()",
].join(", ");

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
export function securityHeaders(env: Env = process.env, nonce?: string): Array<{ key: string; value: string }> {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env, nonce) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
  if (servesHttps(env)) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}
