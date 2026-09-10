import { afterEach, describe, expect, it } from "vitest";

const { default: nextConfig } = await import("../next.config");
const { contentSecurityPolicy, securityHeaders } = await import("@/lib/security-headers");
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
function served(): Headers {
  return proxyModule.proxy().headers;
}

afterEach(() => {
  delete process.env.APP_BASE_URL;
});

describe("security headers", () => {
  it("stops the app being framed, which is what the one-click settings buttons need", () => {
    const production = headerMap({ NODE_ENV: "production" });
    expect(directives(production["Content-Security-Policy"])["frame-ancestors"]).toEqual(["'none'"]);
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

  it("allows platform thumbnails and video but keeps everything else on this origin", () => {
    const csp = directives(contentSecurityPolicy({ NODE_ENV: "production" }));
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["img-src"]).toContain("https:"); // arbitrary platform CDNs
    expect(csp["img-src"]).toContain("data:"); // demo thumbnails are inline SVG
    expect(csp["media-src"]).toContain("https:");
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
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
    expect(headers.get("permissions-policy")).toContain("camera=()");
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
