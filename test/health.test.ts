import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

process.env.SESSION_SECRET = "test-secret-for-health-tests";

const { GET } = await import("@/app/api/health/route");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_FILE;
});

/**
 * A container or uptime checker calls this with no cookie and reads whatever comes back, so the
 * route has to answer without a session and must not say anything a stranger should not know.
 */
describe("GET /api/health", () => {
  it("answers 200 with exactly ok and version, and needs no request or session to do it", async () => {
    // Called with no request at all: a route behind `withUser` would look for the session
    // cookie, which throws outside a request scope, and answer 500 instead.
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(body).toEqual({ ok: true, version: pkg.version });
    // A checker must see the current answer, never a cached one.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not go through the session gate", () => {
    // Comments may name the gate to say it is absent; only real import statements matter.
    const source = readFileSync("src/app/api/health/route.ts", "utf8");
    const imports = [...source.matchAll(/^\s*import\s+(.+?)\s+from\s+["'](.+?)["']/gm)].map((m) => ({ names: m[1], from: m[2] }));
    expect(imports.map((i) => i.from)).not.toContain("@/lib/session");
    expect(imports.map((i) => i.from)).not.toContain("next/headers");
    for (const { names } of imports) expect(names).not.toMatch(/withUser|requireUser|currentUser|cookies/);
  });

  it("never says where the data lives or what the environment holds", async () => {
    process.env.DATA_DIR = "/srv/very-particular-place";
    process.env.DATABASE_FILE = "/srv/very-particular-place/scroll.sqlite";
    const text = JSON.stringify(await GET().json());
    expect(text).not.toContain("very-particular-place");
    expect(text).not.toMatch(/sqlite|DATA_DIR|SESSION_SECRET|NODE_ENV/);
  });
});
