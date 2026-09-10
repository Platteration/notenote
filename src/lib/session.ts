import { cookies } from "next/headers";
import { getDb, now, type UserRow } from "./db";
import { hashToken, randomToken } from "./crypto";

export const SESSION_COOKIE = "ds_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The cookie carries a random token; the database stores only its hash.
 *
 * Nothing in the database is enough to sign in with, so a leaked copy of the file is not thirty
 * days of impersonation for every account. Sessions written before this change hold a raw
 * token, which now matches nothing and is therefore simply dead: upgrading signs everyone out
 * once, and `purgeExpired` removes the rows as they expire.
 */
export async function createSession(userId: string): Promise<void> {
  const token = randomToken(32);
  const db = getDb();
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashToken(token), userId, now(), now() + SESSION_TTL_MS);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
  jar.delete(SESSION_COOKIE);
}

/**
 * The stored key of the signed-in session, so callers can exempt it when revoking the others.
 *
 * This is the hash, not the cookie: it is what the sessions table holds, and comparing the raw
 * cookie against that column would match nothing — signing the user out of the very device
 * changing the password.
 */
export async function currentSessionKey(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

/** How many sessions this account currently has open. */
export function sessionCountFor(userId: string): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?").get(userId, now()) as {
      c: number;
    }
  ).c;
}

export async function currentUser(): Promise<UserRow | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now()) as UserRow | undefined;
  return row ?? null;
}

export async function requireUser(): Promise<UserRow> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthorizedError";
  }
}
