import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-password-tests";

const { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, changePassword, revokeOtherSessions, signIn, signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { hashPassword, newId } = await import("@/lib/crypto");

let userId: string;
const EMAIL = "pw@example.com";
const START = "password123";

function addSession(token: string, expiresAt = Date.now() + 60_000) {
  getDb().prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, 0, expiresAt);
}
function sessionTokens(): string[] {
  return (getDb().prepare("SELECT token FROM sessions WHERE user_id = ? ORDER BY token").all(userId) as Array<{ token: string }>).map(
    (r) => r.token,
  );
}

beforeAll(async () => {
  userId = (await signUp({ email: EMAIL, displayName: "PW", password: START })).id;
});

beforeEach(async () => {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  // Reset to a known password between cases.
  let current: string | null = null;
  for (const candidate of ["fourth-password", "third-password", "second-password", START]) {
    try {
      await signIn(EMAIL, candidate);
      current = candidate;
      break;
    } catch {
      /* not this one */
    }
  }
  if (current && current !== START) await changePassword(userId, current, START, null);
});

describe("changing a password", () => {
  it("requires the current password", async () => {
    await expect(changePassword(userId, "not-my-password", "second-password", null)).rejects.toThrow(
      /current password is incorrect/i,
    );
    await expect(signIn(EMAIL, START)).resolves.toBeTruthy();
  });

  it("enforces the minimum length on the new password", async () => {
    await expect(changePassword(userId, START, "short", null)).rejects.toThrow(/at least 8/);
  });

  it("refuses a no-op change", async () => {
    await expect(changePassword(userId, START, START, null)).rejects.toThrow(/already your password/i);
  });

  it("swaps which password works", async () => {
    await changePassword(userId, START, "second-password", null);
    await expect(signIn(EMAIL, "second-password")).resolves.toBeTruthy();
    await expect(signIn(EMAIL, START)).rejects.toThrow(/incorrect/i);
  });

  it("signs out other devices but keeps the one making the change", async () => {
    addSession("this-device");
    addSession("phone");
    addSession("old-laptop");

    const result = await changePassword(userId, START, "third-password", "this-device");
    expect(result.revokedSessions).toBe(2);
    expect(sessionTokens()).toEqual(["this-device"]);
  });

  it("signs out everything when there is no session to keep", async () => {
    addSession("phone");
    addSession("laptop");
    await changePassword(userId, START, "fourth-password", null);
    expect(sessionTokens()).toEqual([]);
  });

  it("leaves sessions alone when the change is rejected", async () => {
    addSession("this-device");
    addSession("phone");
    await expect(changePassword(userId, "wrong", "second-password", "this-device")).rejects.toThrow();
    expect(sessionTokens()).toHaveLength(2);
  });
});

describe("resisting account enumeration", () => {
  /**
   * A sign-in for an address with no account must cost the same as one for a real account.
   * When the unknown path skipped hashing entirely it answered roughly ten times faster,
   * which told an attacker exactly which addresses were registered and made the deliberately
   * vague error message worthless.
   */
  async function timeSignIn(email: string): Promise<number> {
    const started = process.hrtime.bigint();
    await signIn(email, "definitely-the-wrong-password").catch(() => {});
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  it("takes a comparable amount of time whether or not the account exists", async () => {
    // Warm both paths first so neither pays a one-off cost inside the measurement.
    await timeSignIn(EMAIL);
    await timeSignIn("nobody@example.com");

    const rounds = 3;
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < rounds; i++) {
      known += await timeSignIn(EMAIL);
      unknown += await timeSignIn("nobody@example.com");
    }
    known /= rounds;
    unknown /= rounds;

    // Both do one scrypt, so the unknown path must not be dramatically cheaper. Generous
    // bounds keep this meaningful without being flaky on a loaded machine.
    expect(unknown).toBeGreaterThan(known * 0.4);
    expect(known).toBeGreaterThan(1);
  });

  it("gives the same message either way", async () => {
    const known = await signIn(EMAIL, "wrong").catch((e: Error) => e.message);
    const unknown = await signIn("nobody@example.com", "wrong").catch((e: Error) => e.message);
    expect(known).toBe(unknown);
  });
});

describe("signing out other devices", () => {
  it("removes every session except the current one", () => {
    addSession("this-device");
    addSession("phone");
    addSession("tablet");
    expect(revokeOtherSessions(userId, "this-device")).toBe(2);
    expect(sessionTokens()).toEqual(["this-device"]);
  });

  it("reports nothing to do when only this device is signed in", () => {
    addSession("this-device");
    expect(revokeOtherSessions(userId, "this-device")).toBe(0);
  });

  it("never touches another account's sessions", async () => {
    const other = (await signUp({ email: "other@example.com", displayName: "O", password: "password123" })).id;
    getDb().prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('theirs', ?, 0, ?)").run(other, Date.now() + 60_000);
    addSession("this-device");
    addSession("phone");
    revokeOtherSessions(userId, "this-device");
    expect(getDb().prepare("SELECT token FROM sessions WHERE user_id = ?").all(other)).toEqual([{ token: "theirs" }]);
  });
});

/**
 * The ceilings on how long a credential may be belong to the paths that *write* one.
 *
 * signUp had no maximum until recently, so a row can hold a password longer than signUp would
 * now accept — and there is no password reset anywhere in this app, so if sign-in or
 * change-password refused such a credential on length the account would be shut for good.
 * These build the row the way the old signUp would have, rather than through the current API,
 * because the current API can no longer produce it.
 */
describe("an account whose credentials predate the length ceilings", () => {
  const LONG_PASSWORD = "z".repeat(MAX_PASSWORD_LENGTH + 1);
  const LONG_EMAIL = `${"l".repeat(MAX_EMAIL_LENGTH)}@example.com`;

  async function legacyAccount(email: string, password: string): Promise<string> {
    const id = newId();
    getDb()
      .prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, email, "Legacy", await hashPassword(password), Date.now());
    return id;
  }

  it("can still sign in with the password it was created with", async () => {
    await legacyAccount("legacy-pw@example.com", LONG_PASSWORD);
    const user = await signIn("legacy-pw@example.com", LONG_PASSWORD);
    expect(user.email).toBe("legacy-pw@example.com");
    // Still the wrong password for anything else.
    await expect(signIn("legacy-pw@example.com", `${LONG_PASSWORD}x`)).rejects.toThrow(/incorrect/i);
  });

  it("can still sign in with an address longer than the ceiling", async () => {
    expect(LONG_EMAIL.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
    await legacyAccount(LONG_EMAIL, "password123");
    await expect(signIn(LONG_EMAIL, "password123")).resolves.toBeTruthy();
  });

  it("can change that password, which is the only way out of it", async () => {
    const id = await legacyAccount("legacy-change@example.com", LONG_PASSWORD);
    await changePassword(id, LONG_PASSWORD, "a-sensible-password", null);
    await expect(signIn("legacy-change@example.com", "a-sensible-password")).resolves.toBeTruthy();
  });

  it("still refuses to create or set one that long", async () => {
    await expect(
      signUp({ email: "too-long@example.com", displayName: "T", password: LONG_PASSWORD }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_PASSWORD_LENGTH}`));
    const id = await legacyAccount("legacy-new@example.com", "password123");
    await expect(changePassword(id, "password123", LONG_PASSWORD, null)).rejects.toThrow(
      new RegExp(`at most ${MAX_PASSWORD_LENGTH}`),
    );
  });
});
