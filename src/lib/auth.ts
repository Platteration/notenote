import { getDb, now, type UserRow } from "./db";
import { hashPassword, newId, verifyPassword } from "./crypto";
import { saveSettings } from "./settings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD_LENGTH = 8;

export function signUp(input: { email: string; displayName: string; password: string; timezone?: string }): UserRow {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address");
  if (displayName.length < 1 || displayName.length > 60) throw new Error("Pick a display name (1-60 characters)");
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (exists) throw new Error("An account with that email already exists");
  const user: UserRow = {
    id: newId(),
    email,
    display_name: displayName,
    password_hash: hashPassword(input.password),
    created_at: now(),
  };
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    user.id,
    user.email,
    user.display_name,
    user.password_hash,
    user.created_at,
  );
  if (input.timezone) {
    try {
      saveSettings(user.id, { timezone: input.timezone });
    } catch {
      /* fall back to UTC */
    }
  }
  return user;
}

export function signIn(email: string, password: string): UserRow {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) throw new Error("Email or password is incorrect");
  return row;
}

export interface PasswordChangeResult {
  /** Sessions on other devices that were signed out as a result. */
  revokedSessions: number;
}

/**
 * Change a password, proving ownership with the current one.
 *
 * Every other session is revoked. If someone else had a session on this account — the whole
 * reason a person changes a password in a hurry — leaving those live would defeat the point.
 * The session doing the changing is kept so the user isn't signed out of their own device.
 */
export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionToken: string | null,
): PasswordChangeResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!row) throw new Error("Account not found");
  if (!verifyPassword(currentPassword, row.password_hash)) throw new Error("Your current password is incorrect");
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (verifyPassword(newPassword, row.password_hash)) throw new Error("That is already your password");

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  const revoked = keepSessionToken
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepSessionToken)
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return { revokedSessions: Number(revoked.changes) };
}

/** Sign out every session except the one making the request. */
export function revokeOtherSessions(userId: string, keepSessionToken: string | null): number {
  const db = getDb();
  const result = keepSessionToken
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepSessionToken)
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
}
