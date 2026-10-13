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

/**
 * Whether an address can be an account's: at most MAX_EMAIL_LENGTH, and shaped like one. The
 * length is decided first and an address past it is never matched: EMAIL_RE backtracks
 * quadratically over a run of dots (`a@` and 60,000 of them took eight seconds), and those
 * seconds are the only thread the server has. At MAX_EMAIL_LENGTH the worst case is a fraction
 * of a millisecond.
 */
export function isAcceptableEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}

/**
 * What `password_hash` holds for an account made by signing in with Google, which has no
 * password. It is not a hash `verifyPassword` can match (no `scrypt$` prefix), so nothing typed
 * at the password sign-in opens such an account, and `signIn` spends the decoy hash on it so
 * the answer takes as long as any other wrong password.
 */
export const NO_PASSWORD = "none";

/** Whether an account has a password at all; one made with Google has none. */
export function hasPassword(row: Pick<UserRow, "password_hash">): boolean {
  return row.password_hash !== NO_PASSWORD;
}

/**
 * The deployment-wide ceiling on new accounts, and the per-address one behind a trusted proxy.
 * Shared by the sign-up form (`/api/auth/signup`) and the first sign-in with a Google account
 * (`src/lib/google-accounts.ts`), which also makes an account: either way is one more account.
 */
export const SIGNUP_PER_IP = { limit: 5, windowMs: 60 * 60_000 };
export const SIGNUP_PER_DEPLOYMENT = { key: "signup:deployment", limit: 200, windowMs: 60 * 60_000 };

export async function signUp(input: {
  email: string;
  displayName: string;
  password: string;
  timezone?: string;
}): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  // This route is unauthenticated with a body of up to 64 KB: see isAcceptableEmail for why the
  // length is decided before the pattern runs.
  if (!isAcceptableEmail(email)) throw new UserFacingError("Enter a valid email address");
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
  // Hash against a decoy when there is no such account, or when it has no password (one made
  // with Google), so every outcome costs the same.
  const usable = row && hasPassword(row) ? row : undefined;
  const ok = await verifyPassword(password, usable ? usable.password_hash : await decoyHash());
  if (!usable || !ok) throw new UserFacingError(WRONG_CREDENTIALS);
  return usable;
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
  if (!hasPassword(row)) throw new UserFacingError("This account signs in with Google and has no password to change");
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
