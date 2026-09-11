import { afterAll, describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A real directory and a real file, because the modes and the migration are the subject here. */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ds-at-rest-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.DATABASE_FILE;
process.env.SESSION_SECRET = "test-secret-for-storage-at-rest";

const { decrypt } = await import("@/lib/crypto");
const { getDb, now } = await import("@/lib/db");

const DB_FILE = path.join(DATA_DIR, "daily-scroll.db");
const SECRET = process.env.SESSION_SECRET;

/** A ciphertext in the superseded format: AES-256-GCM under a bare sha256 of the secret. */
function legacyCiphertext(plain: string): string {
  const key = nodeCrypto.createHash("sha256").update(SECRET).digest();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const id = nodeCrypto.createHash("sha256").update(key).digest("base64url").slice(0, 8);
  return [id, iv, cipher.getAuthTag(), enc].map((b) => (typeof b === "string" ? b : b.toString("base64url"))).join(".");
}

/** What a restart does: the next call to getDb() opens the file again and migrates it. */
function reopen() {
  (globalThis as { __dailyScrollDb?: unknown }).__dailyScrollDb = undefined;
  return getDb();
}

afterAll(() => {
  (globalThis as { __dailyScrollDb?: unknown }).__dailyScrollDb = undefined;
  delete process.env.DATA_DIR;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * The file is what another account on the host actually reads, and the directory bit was the
 * only thing protecting it. `mkdirSync`'s mode applies to a directory it creates, and the shape
 * .env.example recommends is one the operator already made — at 0755.
 */
describe("what the database is readable by", () => {
  it("is nobody but the owner: the file, its WAL and its shared memory", () => {
    getDb().prepare("SELECT 1").get();
    // Derived from the modes themselves, not from the constants in db.ts: no group or other
    // bit may be set on any of the three files SQLite creates.
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${DB_FILE}${suffix}`;
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });

  it("is nobody but the owner for a DATA_DIR the operator made themselves", () => {
    fs.chmodSync(DATA_DIR, 0o755);
    reopen();
    expect(fs.statSync(DATA_DIR).mode & 0o077).toBe(0);
  });
});

/**
 * Tokens written under the old, unstretched key derivation. They still open — upgrading must not
 * strand a connection — but they are not left sitting in the file under a key that a wordlist
 * recovers in milliseconds.
 */
describe("provider tokens written by an earlier version", () => {
  it("are re-keyed when the database is opened, and still say the same thing", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "u1",
      "old@example.com",
      "Old",
      "scrypt$x$y",
      now(),
    );
    const access = legacyCiphertext("ya29.a-real-access-token");
    const refresh = legacyCiphertext("a-real-refresh-token");
    db.prepare(
      `INSERT INTO connections (user_id, provider, provider_user_id, display_name, access_token, refresh_token, expires_at, scope, demo, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("u1", "youtube", "p1", "Old account", access, refresh, null, null, now());

    const row = reopen().prepare("SELECT access_token, refresh_token FROM connections WHERE user_id = ?").get("u1") as {
      access_token: string;
      refresh_token: string;
    };

    expect(row.access_token).not.toBe(access);
    expect(row.refresh_token).not.toBe(refresh);
    expect(decrypt(row.access_token)).toBe("ya29.a-real-access-token");
    expect(decrypt(row.refresh_token)).toBe("a-real-refresh-token");
    // The old key id was a sha256 of a sha256 of the secret; nothing in the row answers to it.
    const oldId = nodeCrypto
      .createHash("sha256")
      .update(nodeCrypto.createHash("sha256").update(SECRET).digest())
      .digest("base64url")
      .slice(0, 8);
    expect(row.access_token.split(".")[0]).not.toBe(oldId);
    expect(row.refresh_token.split(".")[0]).not.toBe(oldId);
  });
});
