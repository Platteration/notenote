import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-login-limit-tests";

/** The route sets a session cookie on success, and outside a request there is no cookie jar. */
const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));

const { signUp } = await import("@/lib/auth");
const { rateLimit, resetAllRateLimits } = await import("@/lib/rate-limit");
const { POST } = await import("@/app/api/auth/login/route");
const { POST: signUpRoute } = await import("@/app/api/auth/signup/route");

const VICTIM = "victim@example.com";
const PASSWORD = "correct horse battery";

const attempt = (email: string, password: string) =>
  POST(
    new Request("https://scroll.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ email, password }),
    }),
  );

/**
 * Spend the account-wide ceiling without paying for a scrypt per guess.
 *
 * The bucket is the shared one the route counts on, so filling it here is the same state a
 * stranger reaches with wrong guesses — 500 is past any ceiling the route could sanely hold,
 * which is the point: the test should not need to know what the number is.
 */
function spendAccountCeiling(email: string): void {
  for (let i = 0; i < 500; i++) rateLimit(`login:acct:${email}`, 1, 15 * 60_000);
}

beforeEach(() => {
  resetAllRateLimits();
  jar.set.mockReset();
});

await signUp({ email: VICTIM, displayName: "V", password: PASSWORD });

/**
 * The property the comment in the route and the README both claim: no stranger can spend a
 * named account's sign-in limit and lock its owner out. There is no password reset in this app,
 * so a lockout has no way out but waiting, and the attacker pays about 15 seconds per window to
 * hold it.
 */
describe("wrong guesses against a named account", () => {
  it("never stop that account's own correct password", async () => {
    spendAccountCeiling(VICTIM);
    const res = await attempt(VICTIM, PASSWORD);
    expect(res.status).toBe(200);
    expect(jar.set).toHaveBeenCalled();
  }, 20_000);

  it("are still refused themselves once the ceiling is spent", async () => {
    spendAccountCeiling(VICTIM);
    const res = await attempt(VICTIM, "not the password");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  }, 20_000);

  it("stop counting as soon as the owner signs in, so they cannot accumulate", async () => {
    spendAccountCeiling(VICTIM);
    expect((await attempt(VICTIM, PASSWORD)).status).toBe(200);
    // 401 rather than 429: the successful sign-in emptied the bucket someone else had filled.
    expect((await attempt(VICTIM, "not the password")).status).toBe(401);
  }, 20_000);
});

/**
 * The other half: an attacker who varies the address instead of repeating one pays no limit at
 * all, because every bucket above is keyed on something they choose. What is left is scrypt on
 * a four-thread pool, which is why the number verifying at once is bounded.
 */
describe("a flood of sign-ins for addresses that do not exist", () => {
  it("is not all admitted to the password hasher at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => attempt(`nobody-${i}@example.com`, "x".repeat(40))),
    );
    const statuses = results.map((r) => r.status);
    const refused = statuses.filter((s) => s === 503);
    expect(refused.length).toBeGreaterThan(0);
    // Everything not refused was actually answered, not queued behind the pool.
    expect(statuses.every((s) => s === 401 || s === 503)).toBe(true);
    expect(statuses.filter((s) => s === 401).length).toBeLessThan(statuses.length);
    expect(results.find((r) => r.status === 503)?.headers.get("Retry-After")).toBeTruthy();
  }, 30_000);
});

/**
 * The sign-up ceiling is for the whole deployment, so whatever spends it stops everybody
 * registering until the window resets. It has to be spent by accounts, not by requests: 200
 * posts of `{}` used to close registration for an hour for about 5 KB of traffic, and the
 * operator saw nothing but 429s.
 */
describe("the deployment-wide sign-up ceiling", () => {
  const post = (body: unknown) =>
    signUpRoute(
      new Request("https://scroll.example/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify(body),
      }),
    );

  it("is not spent by requests that create nothing", async () => {
    // Well past the ceiling, and none of them a registration.
    for (let i = 0; i < 250; i++) expect((await post({})).status).toBe(400);
    const honest = await post({ email: "honest@example.com", displayName: "H", password: "password123" });
    expect(honest.status).toBe(201);
  }, 30_000);

  it("still refuses once that many accounts really have been created", async () => {
    // The bucket the route charges an account to, filled directly: 500 is past any ceiling it
    // could sanely hold, so the test does not need to know the number.
    for (let i = 0; i < 500; i++) rateLimit("signup:deployment", 1, 60 * 60_000);
    const res = await post({ email: "late@example.com", displayName: "L", password: "password123" });
    expect(res.status).toBe(429);
  }, 30_000);
});
