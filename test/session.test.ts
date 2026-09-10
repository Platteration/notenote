import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-session-tests";

/** A cookie jar standing in for the one a request would carry. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { signUp, revokeOtherSessions } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { SESSION_COOKIE, createSession, currentSessionKey, currentUser, destroySession, sessionCountFor } = await import(
  "@/lib/session"
);

let userId: string;

/** Derived from the specification (sha256, base64url), not from the code under test. */
function expectedStoredForm(cookieValue: string): string {
  return crypto.createHash("sha256").update(cookieValue).digest("base64url");
}

const storedTokens = () =>
  (getDb().prepare("SELECT token FROM sessions WHERE user_id = ?").all(userId) as Array<{ token: string }>).map((r) => r.token);

beforeAll(async () => {
  userId = (await signUp({ email: "session@example.com", displayName: "Session", password: "password123" })).id;
});

beforeEach(() => {
  jar.clear();
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
});

describe("session tokens at rest", () => {
  it("stores the hash of the cookie, never the cookie itself", async () => {
    await createSession(userId);
    const cookie = jar.get(SESSION_COOKIE)!;
    expect(cookie).toBeTruthy();

    const stored = storedTokens();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(cookie);
    expect(stored[0]).toBe(expectedStoredForm(cookie));
  });

  it("still recognises the browser that holds the cookie", async () => {
    await createSession(userId);
    expect((await currentUser())?.id).toBe(userId);
    expect(sessionCountFor(userId)).toBe(1);
  });

  it("does not accept the stored value as a cookie, which is the whole point", async () => {
    // Somebody who can read the database file — a leaked backup, a world-readable DATA_DIR —
    // holds this string. Presenting it must not be a sign-in.
    await createSession(userId);
    jar.set(SESSION_COOKIE, storedTokens()[0]);
    expect(await currentUser()).toBeNull();
  });

  it("signs out the browser that asks", async () => {
    await createSession(userId);
    await destroySession();
    expect(storedTokens()).toHaveLength(0);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe("revoking the other devices", () => {
  it("keeps the session doing the revoking and drops the rest", async () => {
    await createSession(userId);
    const mine = jar.get(SESSION_COOKIE)!;
    // Two other devices, stored the same way a real sign-in would store them.
    for (const other of ["another-device", "a-third-device"]) {
      getDb()
        .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(expectedStoredForm(other), userId, Date.now(), Date.now() + 60_000);
    }

    const keep = await currentSessionKey();
    expect(keep).toBe(expectedStoredForm(mine));
    expect(revokeOtherSessions(userId, keep)).toBe(2);

    // The device that asked is still signed in: passing the raw cookie here instead of the
    // stored form would have matched no row and signed it out with the others.
    expect((await currentUser())?.id).toBe(userId);
    expect(sessionCountFor(userId)).toBe(1);
  });
});
