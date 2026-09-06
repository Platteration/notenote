import { getDb, now, type UserRow } from "./db";
import { hashPassword, newId, verifyPassword } from "./crypto";
import { saveSettings } from "./settings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signUp(input: { email: string; displayName: string; password: string; timezone?: string }): UserRow {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address");
  if (displayName.length < 1 || displayName.length > 60) throw new Error("Pick a display name (1-60 characters)");
  if (input.password.length < 8) throw new Error("Password must be at least 8 characters");
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
