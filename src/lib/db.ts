/**
 * Persistence layer backed by Node's built-in SQLite (node:sqlite).
 * No native dependencies: the database file lives at DATA_DIR/daily-scroll.db.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { upgradeCiphertext } from "./crypto";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

export interface SettingsRow {
  user_id: string;
  timezone: string;
  window_start: string; // "HH:MM" local wall-clock time
  feed_size: number;
  updated_at: number;
  /** JSON blob of appearance and experience preferences; see lib/settings.ts. */
  prefs: string;
}

export interface ConnectionRow {
  user_id: string;
  provider: string;
  provider_user_id: string;
  display_name: string;
  access_token: string; // encrypted
  refresh_token: string | null; // encrypted
  expires_at: number | null;
  scope: string | null;
  demo: number;
  connected_at: number;
}

export interface DailyFeedRow {
  user_id: string;
  day_key: string;
  items_json: string;
  generated_at: number;
  opens_at: number;
  closes_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  -- The sha256 of the cookie value, never the cookie itself. See lib/session.ts.
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  window_start TEXT NOT NULL,
  feed_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_feeds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  items_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_key)
);
CREATE TABLE IF NOT EXISTS hour_opens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_key)
);
CREATE TABLE IF NOT EXISTS seen_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE TABLE IF NOT EXISTS saved_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_json TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE TABLE IF NOT EXISTS muted_creators (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  creator_handle TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider, creator_handle)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_open_day TEXT
);
CREATE TABLE IF NOT EXISTS provider_cache (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  items_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`;

declare global {
  var __dailyScrollDb: DatabaseSync | undefined;
}

/**
 * Owner-only, applied rather than requested.
 *
 * `mkdirSync`'s mode only applies to a directory it creates, and the deployment shape
 * .env.example recommends is one the operator makes themselves — `mkdir`, a systemd
 * `StateDirectory=`, a Docker volume — all of which arrive at 0755. SQLite then creates the
 * database, its WAL and its shared-memory file at 0644, and the file is the thing another
 * account on the host actually reads: every email address and password hash, every encrypted
 * platform token, every push endpoint with its keys. Best effort, because a filesystem with no
 * modes, or a path owned by someone else, must not stop the app from starting — but it says so.
 */
function restrict(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    console.warn(`Could not make ${target} owner-only; check its permissions by hand.`);
  }
}

export function getDb(): DatabaseSync {
  if (globalThis.__dailyScrollDb) return globalThis.__dailyScrollDb;
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  restrict(dataDir, 0o700);
  const file =
    process.env.DATABASE_FILE === ":memory:"
      ? ":memory:"
      : path.join(dataDir, "daily-scroll.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // After the first exec, so the WAL and shared-memory files exist to be restricted too.
  if (file !== ":memory:") for (const f of [file, `${file}-wal`, `${file}-shm`]) restrict(f, 0o600);
  migrate(db);
  globalThis.__dailyScrollDb = db;
  return db;
}

/** Add a column to an existing table if it is missing. SQLite has no IF NOT EXISTS for columns. */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/**
 * Re-key provider tokens written under the superseded key derivation.
 *
 * Those ciphertexts were encrypted with a bare sha256 of SESSION_SECRET and carry a key id that
 * was a free offline verifier for it, so leaving them in place would leave the hole open for
 * every connection made before this version. A row no configured secret can open is left
 * exactly as it is — a secret rotated away without PREVIOUS_SESSION_SECRETS is not this
 * migration's to lose — and upgrades itself the next time it is opened.
 */
function reencryptTokens(db: DatabaseSync): void {
  const rows = db.prepare("SELECT user_id, provider, access_token, refresh_token FROM connections").all() as unknown as Array<
    Pick<ConnectionRow, "user_id" | "provider" | "access_token" | "refresh_token">
  >;
  for (const row of rows) {
    const access = upgradeCiphertext(row.access_token);
    const refresh = row.refresh_token ? upgradeCiphertext(row.refresh_token) : null;
    if (!access && !refresh) continue;
    db.prepare("UPDATE connections SET access_token = ?, refresh_token = ? WHERE user_id = ? AND provider = ?").run(
      access ?? row.access_token,
      refresh ?? row.refresh_token,
      row.user_id,
      row.provider,
    );
  }
}

/** Bring databases created by earlier versions up to the current schema. */
function migrate(db: DatabaseSync): void {
  ensureColumn(db, "settings", "prefs", "prefs TEXT NOT NULL DEFAULT '{}'");
  // Streaks used to be counted from daily_feeds, which the housekeeping sweep empties a day
  // after each hour closes, so they could never reach three. hour_opens is the ledger now;
  // seed it from whatever feed rows a database still has so nobody's streak restarts at zero.
  db.exec(
    `INSERT OR IGNORE INTO hour_opens (user_id, day_key, opened_at)
     SELECT user_id, day_key, generated_at FROM daily_feeds`,
  );
  reencryptTokens(db);
}

export function now(): number {
  return Date.now();
}
