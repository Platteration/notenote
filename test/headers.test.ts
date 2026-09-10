import { describe, expect, it } from "vitest";

const { default: nextConfig, contentSecurityPolicy, securityHeaders } = await import("../next.config");

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

describe("security headers", () => {
  it("applies to every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    // path-to-regexp: a zero-or-more parameter, so "/" and "/a/b/c" both match.
    expect(rules[0].source).toBe("/:path*");
    expect(rules[0].headers.map((h) => h.key)).toContain("Content-Security-Policy");
  });

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
