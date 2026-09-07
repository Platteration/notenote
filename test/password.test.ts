import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-password-tests";

const { changePassword, revokeOtherSessions, signIn, signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");

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

beforeAll(() => {
  userId = signUp({ email: EMAIL, displayName: "PW", password: START }).id;
});

beforeEach(() => {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  // Reset to a known password between cases.
  const current = ["fourth-password", "third-password", "second-password", START].find((candidate) => {
    try {
      signIn(EMAIL, candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (current && current !== START) changePassword(userId, current, START, null);
});

describe("changing a password", () => {
  it("requires the current password", () => {
    expect(() => changePassword(userId, "not-my-password", "second-password", null)).toThrow(/current password is incorrect/i);
    expect(() => signIn(EMAIL, START)).not.toThrow();
  });

  it("enforces the minimum length on the new password", () => {
    expect(() => changePassword(userId, START, "short", null)).toThrow(/at least 8/);
  });

  it("refuses a no-op change", () => {
    expect(() => changePassword(userId, START, START, null)).toThrow(/already your password/i);
  });

  it("swaps which password works", () => {
    changePassword(userId, START, "second-password", null);
    expect(() => signIn(EMAIL, "second-password")).not.toThrow();
    expect(() => signIn(EMAIL, START)).toThrow(/incorrect/i);
  });

  it("signs out other devices but keeps the one making the change", () => {
    addSession("this-device");
    addSession("phone");
    addSession("old-laptop");

    const result = changePassword(userId, START, "third-password", "this-device");
    expect(result.revokedSessions).toBe(2);
    expect(sessionTokens()).toEqual(["this-device"]);
  });

  it("signs out everything when there is no session to keep", () => {
    addSession("phone");
    addSession("laptop");
    changePassword(userId, START, "fourth-password", null);
    expect(sessionTokens()).toEqual([]);
  });

  it("leaves sessions alone when the change is rejected", () => {
    addSession("this-device");
    addSession("phone");
    expect(() => changePassword(userId, "wrong", "second-password", "this-device")).toThrow();
    expect(sessionTokens()).toHaveLength(2);
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

  it("never touches another account's sessions", () => {
    const other = signUp({ email: "other@example.com", displayName: "O", password: "password123" }).id;
    getDb().prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('theirs', ?, 0, ?)").run(other, Date.now() + 60_000);
    addSession("this-device");
    addSession("phone");
    revokeOtherSessions(userId, "this-device");
    expect(getDb().prepare("SELECT token FROM sessions WHERE user_id = ?").all(other)).toEqual([{ token: "theirs" }]);
  });
});
