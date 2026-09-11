import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-signup-ceiling-tests";

/** The route sets a session cookie on success, and outside a request there is no cookie jar. */
const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));

/**
 * Sign-up's password hash, made cheap.
 *
 * What is under test is where the ceiling is charged, not what the hash costs: the defect was
 * that the bucket was read on the way in and charged after `signUp`, so every request that
 * arrived while the first was hashing read the same unspent bucket. Any await between the two
 * reproduces it, and a real scrypt apiece would make a few hundred concurrent sign-ups take
 * minutes. The stored value keeps the shape a hash has, so nothing downstream sees a difference.
 */
vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto")>();
  return { ...actual, hashPassword: async (password: string) => `scrypt$test$${Buffer.from(password).toString("base64url")}` };
});

const { getDb } = await import("@/lib/db");
const { resetAllRateLimits } = await import("@/lib/rate-limit");
const { POST } = await import("@/app/api/auth/signup/route");

const signUpRequest = (email: string) =>
  POST(
    new Request("https://scroll.example/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ email, displayName: "A", password: "password123" }),
    }),
  );

const accounts = () => (getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

beforeEach(() => {
  resetAllRateLimits();
  getDb().exec("DELETE FROM users");
});

/**
 * With no trusted proxy naming the client — the default, and what `.env.example` ships — the
 * per-address bucket cannot run and this deployment-wide ceiling is the only limit on
 * registration there is. It has to hold against the traffic bulk registration actually looks
 * like, which is concurrent: 260 sign-ups sent at once created 260 accounts against a ceiling of
 * 200, because the bucket was read on the way in and only charged after the password was hashed.
 */
describe("the deployment-wide sign-up ceiling", () => {
  it("holds when the requests arrive together, not just one after another", async () => {
    const fired = 260;
    const results = await Promise.all(Array.from({ length: fired }, (_, i) => signUpRequest(`bulk-${i}@example.com`)));
    const statuses = results.map((r) => r.status);
    const created = statuses.filter((s) => s === 201).length;

    expect(statuses.every((s) => s === 201 || s === 429)).toBe(true);
    expect(created).toBeLessThan(fired);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // Every 201 is an account and every account is a 201: the count is the ceiling's subject.
    expect(accounts()).toBe(created);

    // And it stays spent: the window, not the burst, is what reopens registration.
    const after = await Promise.all(Array.from({ length: 20 }, (_, i) => signUpRequest(`later-${i}@example.com`)));
    expect(after.every((r) => r.status === 429)).toBe(true);
    expect(accounts()).toBe(created);
  }, 60_000);

  it("is not spent by concurrent requests that create nothing", async () => {
    // The other half of the same bucket: a reservation is held only while the request is in
    // flight, so junk that creates nothing must leave the ceiling where it found it.
    const junk = await Promise.all(
      Array.from({ length: 250 }, () =>
        POST(
          new Request("https://scroll.example/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
            body: JSON.stringify({}),
          }),
        ),
      ),
    );
    expect(junk.every((r) => r.status === 400 || r.status === 429)).toBe(true);
    const honest = await signUpRequest("honest@example.com");
    expect(honest.status).toBe(201);
  }, 60_000);
});
