/**
 * What a Google sign-in does to the accounts here, once Google has said who it is.
 *
 * A Google account is known by its subject identifier (`sub`), never by its email address. So:
 *
 * - A `sub` that is linked signs in to the account it is linked to, whatever address either side
 *   holds now.
 * - A `sub` that is not linked makes a new account, keyed by that `sub`, with Google's verified
 *   address as its email and no password. If an account here already has that address, nothing
 *   is made and nothing is linked: the address was typed into a sign-up form here, which proves
 *   nothing about who owns it (this app sends no email), so matching on it would hand whoever
 *   typed it first the account of whoever signs in with Google later, or the reverse. The person
 *   is told to sign in with that account's password and link Google from Settings.
 * - Linking happens only from Settings, in a session already signed in to the account, and the
 *   callback checks it is still that session's account.
 */
import { isAcceptableEmail, NO_PASSWORD, SIGNUP_PER_DEPLOYMENT, SIGNUP_PER_IP } from "./auth";
import { newId } from "./crypto";
import { getDb, now, transaction, type UserRow } from "./db";
import { rateLimit, refundRateLimit } from "./rate-limit";
import { saveSettings } from "./settings";
import type { Identity } from "./integrations/google";

export type GoogleSignInResult =
  | { kind: "signed-in"; userId: string; created: boolean }
  /** An account here already holds the Google account's address, and it is not linked. */
  | { kind: "exists" }
  /** Google gave no verified address, so there is nothing to make an account with. */
  | { kind: "no-email" }
  /** The sign-up ceilings are spent. */
  | { kind: "limited"; retryAfter: number };

export type LinkResult = "linked" | "already-linked" | "taken" | "has-another";

interface IdentityRow {
  sub: string;
  user_id: string;
  email: string | null;
  linked_at: number;
}

/** The Google account linked to an account here, if there is one. */
export function googleIdentityFor(userId: string): { email: string | null } | null {
  const row = getDb().prepare("SELECT email FROM google_identities WHERE user_id = ?").get(userId) as { email: string | null } | undefined;
  return row ? { email: row.email } : null;
}

/** A display name from an address's local part, since `openid email` asks Google for no name. */
function displayNameFor(email: string): string {
  const local = email.slice(0, email.indexOf("@")).slice(0, 60).trim();
  return local.length > 0 ? local : "Google user";
}

/**
 * Sign in with a Google identity, making the account when its `sub` is new.
 *
 * `ip` is the trusted client address, when a proxy names one: a new account is charged to the
 * same ceilings the sign-up form is (`/api/auth/signup`), and the same way: the deployment-wide
 * one always and the per-address one behind a trusted proxy, both charged on the way in, and
 * the deployment-wide one refunded when no account came of it.
 */
export function signInWithGoogle(identity: Identity, options: { timezone: string | null; ip: string | null; at?: number }): GoogleSignInResult {
  const at = options.at ?? now();
  const db = getDb();
  const linked = db.prepare("SELECT * FROM google_identities WHERE sub = ?").get(identity.sub) as IdentityRow | undefined;
  if (linked) {
    // Keep the address shown beside "Google" current; it identifies nothing.
    if (identity.email !== undefined && identity.email !== linked.email) {
      db.prepare("UPDATE google_identities SET email = ? WHERE sub = ?").run(identity.email, identity.sub);
    }
    return { kind: "signed-in", userId: linked.user_id, created: false };
  }

  const email = identity.email?.toLowerCase();
  if (!email || !isAcceptableEmail(email)) return { kind: "no-email" };
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return { kind: "exists" };

  const checks = [rateLimit(SIGNUP_PER_DEPLOYMENT.key, SIGNUP_PER_DEPLOYMENT.limit, SIGNUP_PER_DEPLOYMENT.windowMs, at)];
  if (options.ip) checks.push(rateLimit(`signup:ip:${options.ip}`, SIGNUP_PER_IP.limit, SIGNUP_PER_IP.windowMs, at));
  const limited = checks.find((c) => !c.ok);
  let created = false;
  try {
    if (limited) return { kind: "limited", retryAfter: limited.retryAfter };
    // Synchronous from the lookups above to here (node:sqlite is), so no other request can make
    // the same account or take the address in between.
    const user: UserRow = { id: newId(), email, display_name: displayNameFor(email), password_hash: NO_PASSWORD, created_at: at };
    transaction(() => {
      db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
        user.id,
        user.email,
        user.display_name,
        user.password_hash,
        user.created_at,
      );
      db.prepare("INSERT INTO google_identities (sub, user_id, email, linked_at) VALUES (?, ?, ?, ?)").run(identity.sub, user.id, identity.email ?? null, at);
    });
    created = true;
    if (options.timezone) {
      try {
        saveSettings(user.id, { timezone: options.timezone });
      } catch {
        /* an unknown zone falls back to UTC, as the sign-up form's does */
      }
    }
    return { kind: "signed-in", userId: user.id, created: true };
  } finally {
    if (!created) refundRateLimit(SIGNUP_PER_DEPLOYMENT.key, at);
  }
}

/** Link a Google identity to the signed-in account. One Google account per account, both ways. */
export function linkGoogle(userId: string, identity: Identity, at: number = now()): LinkResult {
  const db = getDb();
  return transaction(() => {
    const bySub = db.prepare("SELECT user_id FROM google_identities WHERE sub = ?").get(identity.sub) as { user_id: string } | undefined;
    if (bySub) return bySub.user_id === userId ? "already-linked" : "taken";
    if (db.prepare("SELECT 1 FROM google_identities WHERE user_id = ?").get(userId)) return "has-another";
    db.prepare("INSERT INTO google_identities (sub, user_id, email, linked_at) VALUES (?, ?, ?, ?)").run(identity.sub, userId, identity.email ?? null, at);
    return "linked";
  });
}
