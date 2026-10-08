import { readFileSync } from "node:fs";
import { afterEach, assert, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

const { default: nextConfig } = await import("../next.config");
const { contentSecurityPolicy, PERMISSIONS_POLICY, securityHeaders } = await import("@/lib/security-headers");
const { MAX_REQUEST_BYTES } = await import("@/lib/api");
const proxyModule = await import("@/proxy");

/** The policy as a lookup of directive -> sources, so assertions read like the header does. */
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

const headerMap = (env: Record<string, string | undefined>) =>
  Object.fromEntries(securityHeaders(env).map((h) => [h.key, h.value]));

/** What the proxy would put on a response right now, given the process environment. */
function served(headers?: Record<string, string>): Headers {
  return proxyModule.proxy(new NextRequest("http://localhost/", { headers })).headers;
}

/** The nonce a policy carries. */
function nonceOf(csp: string | null): string {
  const match = /'nonce-([^']+)'/.exec(csp ?? "");
  if (!match?.[1]) throw new Error(`no nonce in ${csp}`);
  return match[1];
}

afterEach(() => {
  delete process.env.APP_BASE_URL;
});

describe("security headers", () => {
  it("stops the app being framed, which is what the one-click settings buttons need", () => {
    const production = headerMap({ NODE_ENV: "production" });
    const csp = production["Content-Security-Policy"];
    assert.isDefined(csp, "production sends a Content-Security-Policy");
    expect(directives(csp)["frame-ancestors"]).toEqual(["'none'"]);
    // The older header too, for anything that does not implement frame-ancestors.
    expect(production["X-Frame-Options"]).toBe("DENY");
  });

  it("sends the rest of the baseline", () => {
    const production = headerMap({ NODE_ENV: "production" });
    expect(production["X-Content-Type-Options"]).toBe("nosniff");
    expect(production["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("allows platform thumbnails and video and refuses everything it does not name", () => {
    const csp = directives(contentSecurityPolicy({ NODE_ENV: "production" }));
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["img-src"]).toContain("https:"); // arbitrary platform CDNs
    expect(csp["img-src"]).toContain("data:"); // demo thumbnails are inline SVG
    expect(csp["media-src"]).toContain("https:");
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    // No page sets a <base>, and every form is sent by its script.
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
  });

  it("runs an inline script only when it carries this response's nonce", () => {
    const csp = directives(contentSecurityPolicy({ NODE_ENV: "production" }, "n0nce"));
    expect(csp["script-src"]).toEqual(["'self'", "'nonce-n0nce'"]);
    // Styles: the stylesheet, and style attributes; an injected <style> element is refused.
    expect(csp["style-src"]).toEqual(["'self'"]);
    expect(csp["style-src-attr"]).toEqual(["'unsafe-inline'"]);
    expect(contentSecurityPolicy({ NODE_ENV: "production" }, "n0nce")).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("asks for https upgrades only where the deployment answers on https", () => {
    // Measured: over plain http on a LAN address the upgrade sent every script, stylesheet and
    // font to https on the same port, where nothing answered.
    expect(directives(contentSecurityPolicy({ NODE_ENV: "production", APP_BASE_URL: "https://scroll.example" }))).toHaveProperty("upgrade-insecure-requests");
    expect(directives(contentSecurityPolicy({ NODE_ENV: "production", APP_BASE_URL: "http://192.168.1.5:3000" }))).not.toHaveProperty("upgrade-insecure-requests");
    expect(directives(contentSecurityPolicy({ NODE_ENV: "production" }))).not.toHaveProperty("upgrade-insecure-requests");
  });

  it("denies every powerful feature but autoplay, each named once", () => {
    const entries = PERMISSIONS_POLICY.split(", ");
    const features = entries.map((e) => e.split("=")[0]);
    expect(new Set(features).size).toBe(features.length);
    expect(entries.filter((e) => !e.endsWith("=()"))).toEqual(["autoplay=(self)"]);
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) expect(entries).toContain(`${feature}=()`);
    expect(headerMap({ NODE_ENV: "production" })["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
  });

  it("keeps eval and the dev socket out of a built server", () => {
    const production = contentSecurityPolicy({ NODE_ENV: "production" });
    expect(production).not.toContain("unsafe-eval");
    expect(production).not.toContain("ws:");
    // `next dev` compiles React refresh in the browser and hot-reloads over a socket, so a
    // policy that broke development would simply be turned off again.
    const development = contentSecurityPolicy({ NODE_ENV: "development" });
    expect(directives(development)["script-src"]).toContain("'unsafe-eval'");
    expect(directives(development)["connect-src"]).toContain("ws:");
  });

  it("loosens only for `next dev`, not for anything that merely isn't production", () => {
    // The policy is decided per request now, so the running server's NODE_ENV decides it. A
    // built server started with NODE_ENV=staging, or with it unset, is serving real users.
    for (const env of [{ NODE_ENV: "staging" }, {}, { NODE_ENV: "test" }]) {
      const csp = contentSecurityPolicy(env);
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toContain("ws:");
    }
    expect(contentSecurityPolicy({ NODE_ENV: "development" })).toContain("unsafe-eval");
  });

  it("promises https only where the deployment says it serves https", () => {
    expect(headerMap({ NODE_ENV: "production", APP_BASE_URL: "https://scroll.example" })["Strict-Transport-Security"]).toMatch(
      /max-age=31536000/,
    );
    expect(headerMap({ NODE_ENV: "production", APP_BASE_URL: "http://localhost:3000" })["Strict-Transport-Security"]).toBeUndefined();
    expect(headerMap({ NODE_ENV: "production" })["Strict-Transport-Security"]).toBeUndefined();
  });
});

/**
 * Where the headers come from, which is the half a pure function cannot check.
 *
 * `headers()` in next.config is evaluated once by `next build` and frozen into
 * `.next/routes-manifest.json`; the production server answers from the manifest and never
 * calls the config again. HSTS is decided from `APP_BASE_URL`, so a deployment that builds in
 * CI or an image and sets that variable at `npm start` — what .env.example and the README
 * describe — would have been given the build machine's answer instead of its own.
 */
describe("where the headers are decided", () => {
  it("carries the whole baseline on a real response object", () => {
    const headers = served();
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });

  it("mints a fresh, unguessable nonce for every response", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const nonce = nonceOf(served().get("content-security-policy"));
      // Sixteen random bytes, base64.
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(50);
  });

  it("hands the renderer the same policy the browser gets, so the page's scripts carry its nonce", () => {
    // The framework reads the nonce out of the request's Content-Security-Policy header while it
    // renders; NextResponse.next() forwards an overridden request header under this name.
    const headers = served();
    expect(headers.get("x-middleware-request-content-security-policy")).toBe(headers.get("content-security-policy"));
    expect(headers.get("x-middleware-override-headers")?.split(",")).toContain("content-security-policy");
  });

  it("overwrites a policy the client sent, so the nonce in the page is never the client's choice", () => {
    const headers = served({ "content-security-policy": "script-src 'nonce-chosen-by-the-client'" });
    expect(headers.get("x-middleware-request-content-security-policy")).toBe(headers.get("content-security-policy"));
    expect(nonceOf(headers.get("x-middleware-request-content-security-policy"))).not.toMatch(/chosen/);
  });

  it("reads APP_BASE_URL per request, so HSTS follows the running server and not the build", () => {
    // Nothing is rebuilt or re-imported between these two: the same loaded module answers
    // differently because the process environment changed, which is what a build-time
    // `headers()` entry cannot do.
    process.env.APP_BASE_URL = "https://scroll.example";
    expect(served().get("strict-transport-security")).toMatch(/max-age=31536000/);

    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(served().get("strict-transport-security")).toBeNull();

    delete process.env.APP_BASE_URL;
    expect(served().get("strict-transport-security")).toBeNull();
  });

  it("keeps the headers out of next.config, where a build would freeze them", () => {
    expect(nextConfig.headers).toBeUndefined();
  });

  it("runs for every request: no matcher narrows the proxy", () => {
    // The config entry it replaced was `/:path*`. A matcher here would silently uncover paths.
    expect((proxyModule as { config?: unknown }).config).toBeUndefined();
  });
});

/** Next's `SizeLimit`: either a byte count or a string like "128kb". */
function sizeInBytes(limit: unknown): number {
  if (typeof limit === "number") return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(String(limit));
  if (!m) throw new Error(`not a size: ${String(limit)}`);
  // Neither group is optional, so a match carries both.
  return Number(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2]!.toLowerCase() as "b" | "kb" | "mb" | "gb"];
}

/**
 * What having a proxy costs.
 *
 * Because this file exists at all, Next clones and buffers every request body so the proxy and
 * the route handler can both read it — before the handler is entered. Whatever that ceiling is
 * therefore outranks `MAX_REQUEST_BYTES`, the sign-in limits and `assertSameSite`: on the
 * framework's 10 MB default, an unauthenticated client could hold megabytes per connection on a
 * route that reads no body at all.
 */
describe("the body the framework buffers before any handler runs", () => {
  const configured = nextConfig.experimental?.proxyClientMaxBodySize;

  it("is capped, which having a proxy does not do on its own", () => {
    expect(configured).toBeDefined();
  });

  it("is the size a handler will accept, not orders of magnitude above it", () => {
    // Derived from MAX_REQUEST_BYTES rather than written out, so moving one and not the other
    // fails here. Above it, because the framework truncates past its own cap rather than
    // refusing, and the 413 should still come from the app's counting stream.
    const buffered = sizeInBytes(configured);
    expect(buffered).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(buffered).toBeLessThanOrEqual(MAX_REQUEST_BYTES * 4);
  });
});

/**
 * The README writes the headers out in full, and the browser walk (`scripts/browser-walk.mjs`)
 * holds every live response to that block. This holds the block to the code, so a header
 * changed in one place and not the other fails here before it ships.
 */
describe("the policy is the same everywhere it is written", () => {
  const readme = readFileSync("README.md", "utf8");
  const block = /<!-- headers:begin -->\s*```text\n([\s\S]*?)```\s*<!-- headers:end -->/.exec(readme)?.[1];

  it("is written out in the README", () => {
    assert.isDefined(block, "README.md has the headers block");
  });

  it("is, word for word, what an https deployment sends", () => {
    const lines = (block ?? "").split("\n").filter((l) => l.trim());
    const sent = securityHeaders({ NODE_ENV: "production", APP_BASE_URL: "https://scroll.example" }, "{nonce}").map(
      ({ key, value }) => `${key}: ${value}`,
    );
    expect(lines).toEqual(sent);
  });
});
