import { getDb, now, type UserRow } from "./db";
import { decoyHash, hashPassword, newId, verifyPassword } from "./crypto";
import { UserFacingError } from "./errors";
import { saveSettings } from "./settings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Upper bounds on the two fields a new credential is written from.
 *
 * The email one is RFC 5321's limit on a path, and without it a multi-megabyte string goes
 * into the unique index. The password one is far above any passphrase or password manager
 * output; it keeps a stored credential a sane size.
 *
 * They apply only where a credential is *created* — signUp, and the new password in
 * changePassword. Checking them on the verifying side instead would lock out any account that
 * already has a longer one: signUp had no maximum before, so such rows can exist, and there is
 * no password reset in this app, so sign-in and change-password are the only ways back in. The
 * work an anonymous request can ask for is bounded by MAX_REQUEST_BYTES in lib/api.ts, which
 * is the right place for it: scrypt's cost comes from N and r, not from the length of what is
 * hashed.
 */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 256;

export async function signUp(input: {
  email: string;
  displayName: string;
  password: string;
  timezone?: string;
}): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) throw new UserFacingError("Enter a valid email address");
  if (displayName.length < 1 || displayName.length > 60) throw new UserFacingError("Pick a display name (1-60 characters)");
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserFacingError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (input.password.length > MAX_PASSWORD_LENGTH) {
    throw new UserFacingError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (exists) throw new UserFacingError("An account with that email already exists");
  const user: UserRow = {
    id: newId(),
    email,
    display_name: displayName,
    password_hash: await hashPassword(input.password),
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

const WRONG_CREDENTIALS = "Email or password is incorrect";

export async function signIn(email: string, password: string): Promise<UserRow> {
  // Deliberately no length ceiling here. Whatever is stored has to remain usable: an account
  // made before signUp had a maximum can hold an address or a password longer than signUp
  // would accept today, and refusing it here would be a permanent lockout, with no reset flow
  // to recover through. MAX_REQUEST_BYTES already bounds what an anonymous caller can send.
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
  // Hash against a decoy when there is no such account, so both outcomes cost the same.
  const ok = await verifyPassword(password, row ? row.password_hash : await decoyHash());
  if (!row || !ok) throw new UserFacingError(WRONG_CREDENTIALS);
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
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionKey: string | null,
): Promise<PasswordChangeResult> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!row) throw new UserFacingError("Account not found");
  // The current password is only ever compared, never stored, so the ceiling does not apply to
  // it: an account whose password predates the ceiling has to be able to change it.
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw new UserFacingError("Your current password is incorrect");
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new UserFacingError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    throw new UserFacingError(`New password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (await verifyPassword(newPassword, row.password_hash)) throw new UserFacingError("That is already your password");

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(newPassword), userId);
  const revoked = keepSessionKey
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepSessionKey)
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return { revokedSessions: Number(revoked.changes) };
}

/**
 * Sign out every session except the one making the request.
 *
 * `keepSessionKey` is the *stored* form of the caller's session token — what
 * `currentSessionKey()` returns — because the sessions table holds hashes, not cookies.
 * Passing the raw cookie value here would match no row and sign the caller out of the very
 * device doing the revoking.
 */
export function revokeOtherSessions(userId: string, keepSessionKey: string | null): number {
  const db = getDb();
  const result = keepSessionKey
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepSessionKey)
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
}
