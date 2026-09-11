import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-login-limit-tests";

/** The route sets a session cookie on success, and outside a request there is no cookie jar. */
const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));

/**
 * How many passwords are being hashed at once, counted at the hasher itself rather than guessed
 * from timings. The real verification still runs: this only watches it.
 */
const hashing = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));
vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto")>();
  return {
    ...actual,
    verifyPassword: async (password: string, stored: string) => {
      hashing.inFlight++;
      hashing.peak = Math.max(hashing.peak, hashing.inFlight);
      try {
        return await actual.verifyPassword(password, stored);
      } finally {
        hashing.inFlight--;
      }
    },
  };
});

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
  hashing.peak = 0;
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

  /**
   * The delay past the ceiling is friction, not a bound, and it used to be applied before
   * anything counted the request: 500 over-ceiling guesses were all resident for the same
   * second, each holding a socket and the body the framework had already buffered. That turns
   * the cheapest refusal in the app into a slowloris amplifier. Only so many are held now, and
   * the surplus skips the delay rather than being refused — refusing here would be the account
   * lockout this route exists to avoid.
   */
  it("are not all held for that delay at once", async () => {
    spendAccountCeiling(VICTIM);
    const timed = async () => {
      const started = Date.now();
      const res = await attempt(VICTIM, "not the password");
      return { status: res.status, ms: Date.now() - started };
    };
    // What one over-ceiling guess costs, measured rather than assumed.
    const solo = await timed();
    expect(solo.status).toBe(429);

    const burst = await Promise.all(Array.from({ length: 24 }, timed));
    expect(burst.every((r) => r.status === 429)).toBe(true);
    // Some of them were answered in a fraction of what one costs, which is only possible if
    // they were not all waiting out the delay together.
    expect(burst.filter((r) => r.ms < solo.ms / 2).length).toBeGreaterThan(0);
  }, 60_000);

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
 * a four-thread pool, which is why the number verifying at once is bounded — and the shape of
 * that bound is the whole point. A ceiling that *refused* past it was a deployment-wide sign-in
 * lockout that needed no account name and no address: nine connections of junk sign-ins refused
 * fourteen of twenty correct passwords. So the ceiling queues, and only refuses a caller it
 * could not have served.
 */
const flood = (count: number) =>
  Promise.all(Array.from({ length: count }, (_, i) => attempt(`nobody-${i}-${Math.random()}@example.com`, "x".repeat(40))));

describe("a flood of sign-ins for addresses that do not exist", () => {
  it("is answered rather than refused, and not all admitted to the password hasher at once", async () => {
    const fired = 12;
    const statuses = (await flood(fired)).map((r) => r.status);
    // Every one of them was checked and rejected; none was turned away because another was busy.
    expect(statuses.every((s) => s === 401)).toBe(true);
    // It is a queue rather than a lock — more than one hashes at a time — and it is bounded.
    expect(hashing.peak).toBeGreaterThan(1);
    expect(hashing.peak).toBeLessThan(fired);
  }, 30_000);

  it("does not stop an account's own correct password getting in while it is running", async () => {
    // The junk arrives first and fills the gate; the honest sign-in queues behind all of it.
    const junk = flood(12);
    const honest = await attempt(VICTIM, PASSWORD);
    await junk;
    expect(honest.status).toBe(200);
    expect(jar.set).toHaveBeenCalled();
  }, 30_000);

  it("is refused, not held, once more are waiting than the queue can drain", async () => {
    // Far more than the waiting room holds, so the surplus has to be turned away at once rather
    // than parked on a socket apiece.
    const results = await flood(60);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 401 || s === 503)).toBe(true);
    expect(results.find((r) => r.status === 503)?.headers.get("Retry-After")).toBeTruthy();
    // What was admitted was still bounded while all of that was in flight.
    expect(hashing.peak).toBeLessThan(statuses.length);
  }, 60_000);
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
