import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-limiter-route-tests";

/** The routes set a session cookie on success, and outside a request there is no cookie jar. */
const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));

/**
 * Both password functions, made cheap, and verification made holdable.
 *
 * What is under test is what the routes leave in the limiter, not what scrypt costs: ten thousand
 * real decoy checks would take minutes. `held` parks every verification until it is released, which
 * is how a test fills the sign-in queue on demand. Every check here answers "wrong password".
 */
const verifying = vi.hoisted(() => ({ checks: 0, held: null as Promise<void> | null }));
vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto")>();
  return {
    ...actual,
    hashPassword: async (password: string) => `scrypt$test$${Buffer.from(password).toString("base64url")}`,
    verifyPassword: async () => {
      verifying.checks++;
      if (verifying.held) await verifying.held;
      return false;
    },
  };
});

const { MAX_RATE_LIMIT_BUCKETS, rateLimitIfTracked, resetAllRateLimits } = await import("@/lib/rate-limit");
const { POST: signUp } = await import("@/app/api/auth/signup/route");
const { POST: signIn } = await import("@/app/api/auth/login/route");

const headers = (address?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  "Sec-Fetch-Site": "same-origin",
  ...(address ? { "X-Forwarded-For": address } : {}),
});

let registered = 0;
const register = (address?: string) =>
  signUp(
    new Request("https://scroll.example/api/auth/signup", {
      method: "POST",
      headers: headers(address),
      body: JSON.stringify({ email: `bulk-${registered++}@example.com`, displayName: "B", password: "password123" }),
    }),
  );

const guess = (email: string, address?: string, body = JSON.stringify({ email, password: "wrong guess" })) =>
  signIn(new Request("https://scroll.example/api/auth/login", { method: "POST", headers: headers(address), body }));

/** An IPv6 address per request, as one /64 hands a client 2^64 of them. */
const fresh = (net: number, i: number) => `2001:db8:${net}::${i.toString(16)}`;

beforeEach(() => {
  resetAllRateLimits();
  verifying.checks = 0;
  verifying.held = null;
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

/**
 * The sign-up ceiling is the only limit on registration in a deployment without a trusted proxy,
 * and it shared one capped, least-recently-used map with every sign-in key a caller can mint. Ten
 * thousand of those pushed it out, and the next sign-up was answered 201 inside the window it had
 * closed.
 */
describe("the deployment-wide sign-up ceiling, once reached", () => {
  it("holds against sign-ins from as many fresh addresses as the limiter keeps, behind a proxy", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    // Five accounts an address an hour, so the ceiling is reached from a fresh address each time.
    for (let i = 0; i < 200; i++) expect((await register(fresh(1, i))).status).toBe(201);
    expect((await register(fresh(1, 500))).status).toBe(429);

    // Each leaves a per-address bucket before its body is read, and the body is not JSON, so not
    // one password is checked: the cheapest key there is to mint.
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 1; i++) {
      expect((await guess("", fresh(2, i), "not json")).status).toBe(401);
    }
    expect(verifying.checks).toBe(0);

    expect((await register(fresh(1, 1000))).status).toBe(429);
  }, 60_000);

  it("holds against guesses at as many invented accounts as the limiter keeps, with no proxy", async () => {
    for (let i = 0; i < 200; i++) expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(429);

    // Eight at a time, so every one is admitted to the password check and leaves an account bucket.
    for (let i = 0; i <= MAX_RATE_LIMIT_BUCKETS; i += 8) {
      const batch = Array.from({ length: 8 }, (_, j) => guess(`nobody-${i + j}@example.com`));
      for (const res of await Promise.all(batch)) expect(res.status).toBe(401);
    }
    expect(verifying.checks).toBeGreaterThan(MAX_RATE_LIMIT_BUCKETS);

    expect((await register()).status).toBe(429);
  }, 60_000);
});

/**
 * An account name is the caller's to invent, so its bucket is made only once the verification
 * queue has admitted the attempt: a request the queue turns away must leave nothing behind, or a
 * flood the queue refuses for free would fill the limiter that the queue exists to make costly.
 */
describe("a sign-in the verification queue turns away", () => {
  it("leaves no bucket for the account it named", async () => {
    let release = () => {};
    verifying.held = new Promise<void>((resolve) => { release = resolve; });
    // Far more than the queue's slots and waiting room together, all for accounts nobody has.
    const flood = Array.from({ length: 60 }, (_, i) => guess(`queued-${i}@example.com`));
    const refused = await guess("turned-away@example.com");
    expect(refused.status).toBe(503);
    expect(rateLimitIfTracked("login:acct:turned-away@example.com", 100, 15 * 60_000)).toBeNull();

    release();
    const statuses = (await Promise.all(flood)).map((r) => r.status);
    // Some of the flood was turned away too, and none of those left a bucket either.
    const turnedAway = statuses.flatMap((status, i) => (status === 503 ? [i] : []));
    expect(turnedAway.length).toBeGreaterThan(0);
    for (const i of turnedAway) {
      expect(rateLimitIfTracked(`login:acct:queued-${i}@example.com`, 100, 15 * 60_000)).toBeNull();
    }
  }, 30_000);
});
