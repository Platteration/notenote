import { afterEach, describe, expect, it, vi } from "vitest";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_SECRET = "test-secret-for-token-key-salt-tests";
// A real file, because what the migration does to it is the subject below.
delete process.env.DATABASE_FILE;

const dirs: string[] = [];

/** A fresh module instance is a fresh process as far as the salt file is concerned. */
async function boot(dir: string) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  return await import("@/lib/crypto");
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-salt-"));
  dirs.push(dir);
  return dir;
}

const saltFile = (dir: string) => path.join(dir, "token-key.salt");

afterEach(() => {
  delete process.env.DATA_DIR;
  vi.resetModules();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The salt is the one file an operator is told to back up, and losing it costs every stored
 * provider token. Its only check used to be that `Buffer.from(text, "base64url")` came back with
 * 16 bytes or more — which is not a check: that decoder skips everything outside the alphabet,
 * so a file somebody had edited decoded to a perfectly good salt that was not the original one,
 * and the app went on encrypting under it without a word.
 */
describe("the token key salt on disk", () => {
  it("is written in a form that says what it is, and can be read back", async () => {
    const dir = tempDir();
    const first = await boot(dir);
    const id = first.encrypt("a-token").split(".")[0];
    expect(first.tokenKeyState().saltCreated).toBe(true);

    const contents = fs.readFileSync(saltFile(dir), "utf8");
    expect(contents).toContain("daily-scroll-token-key-salt-v1");
    // Nothing half-written left beside it.
    expect(fs.readdirSync(dir)).toEqual(["token-key.salt"]);
    expect(fs.statSync(saltFile(dir)).mode & 0o077).toBe(0);

    // The next start finds it rather than making another, and derives the same key.
    const second = await boot(dir);
    expect(second.tokenKeyState().saltCreated).toBe(false);
    expect(second.encrypt("a-token").split(".")[0]).toBe(id);
  });

  it("refuses a file that has been edited, instead of reading a different salt out of it", async () => {
    for (const contents of [
      "this used to be a salt, someone edited it by hand\n",
      "# this used to be a salt, someone edited it by hand\n",
      "",
      "not base64url!!\n",
    ]) {
      const dir = tempDir();
      fs.writeFileSync(saltFile(dir), contents);
      const crypto = await boot(dir);
      expect(() => crypto.prepareTokenKey()).toThrow(/is not a token key salt/);
      // And it is left exactly as it was, so the real one can still be restored over it.
      expect(fs.readFileSync(saltFile(dir), "utf8")).toBe(contents);
    }
  });

  it("refuses a salt whose value has been changed by a character", async () => {
    const dir = tempDir();
    (await boot(dir)).prepareTokenKey();
    const written = fs.readFileSync(saltFile(dir), "utf8");
    const [label, value, check] = written.trim().split("\n").at(-1)!.split(" ");
    const flipped = `${value!.slice(0, -1)}${value!.endsWith("A") ? "B" : "A"}`;
    fs.writeFileSync(saltFile(dir), `${label} ${flipped} ${check}\n`);

    const crypto = await boot(dir);
    expect(() => crypto.prepareTokenKey()).toThrow(/is not a token key salt/);
  });

  it("says whether the file or the place it lives is the problem", async () => {
    // Every one of these used to come out as "Could not write the token key salt", which sends
    // an operator to check the permissions of a directory that is fine.
    const withDirectoryInTheWay = tempDir();
    fs.mkdirSync(saltFile(withDirectoryInTheWay));
    const first = await boot(withDirectoryInTheWay);
    expect(() => first.prepareTokenKey()).toThrow(/Could not read the token key salt/);

    // A DATA_DIR that is not a directory, which really is a place-it-lives problem.
    const notADirectory = path.join(tempDir(), "a-file");
    fs.writeFileSync(notADirectory, "");
    const second = await boot(notADirectory);
    expect(() => second.prepareTokenKey()).toThrow(/Could not write the token key salt/);
  });

  it("brings a bare salt from an older build up to the checked form, without changing it", async () => {
    const dir = tempDir();
    const bare = nodeCrypto.randomBytes(16).toString("base64url");
    fs.writeFileSync(saltFile(dir), `${bare}\n`, { mode: 0o600 });

    const first = await boot(dir);
    const id = first.encrypt("a-token").split(".")[0];
    expect(first.tokenKeyState().saltCreated).toBe(false);
    const rewritten = fs.readFileSync(saltFile(dir), "utf8");
    expect(rewritten).toContain("daily-scroll-token-key-salt-v1");
    expect(rewritten).toContain(bare);

    // Same salt, so the same key: nothing already encrypted has been stranded.
    const second = await boot(dir);
    expect(second.encrypt("a-token").split(".")[0]).toBe(id);
  });
});

/** A ciphertext in the superseded format: AES-256-GCM under a bare sha256 of the secret. */
function legacyCiphertext(plain: string): string {
  const key = nodeCrypto.createHash("sha256").update(process.env.SESSION_SECRET!).digest();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const id = nodeCrypto.createHash("sha256").update(key).digest("base64url").slice(0, 8);
  return [id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

/**
 * What a restart does: a fresh module instance, the cached handle let go, and the token key
 * derived at boot the way `src/instrumentation.ts` derives it — which is what creates the salt
 * file when there is none.
 */
async function restart(dir: string) {
  (globalThis as { __dailyScrollDb?: unknown }).__dailyScrollDb = undefined;
  vi.resetModules();
  process.env.DATA_DIR = dir;
  const crypto = await import("@/lib/crypto");
  crypto.prepareTokenKey();
  return { db: await import("@/lib/db"), crypto };
}

/**
 * The irreversible half of losing the salt.
 *
 * The re-key migration runs on every open, so a deployment that boots with a salt it has just
 * generated — a database restored without its salt file — would rewrite every remaining legacy
 * row under a key that is not this database's. Those rows stop being legacy, so putting the real
 * salt back afterwards does not bring them back and the migration never looks at them again: a
 * recoverable mistake turned into a permanent one by the thing meant to be an upgrade.
 */
describe("a database opened beside a salt it has never seen", () => {
  it("is not re-keyed, says so, and comes back when the salt does", async () => {
    const dir = tempDir();
    const first = await restart(dir);
    const db = first.db.getDb();
    db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "u1",
      "old@example.com",
      "Old",
      "scrypt$x$y",
      first.db.now(),
    );
    const stored = legacyCiphertext("ya29.a-real-access-token");
    db.prepare(
      `INSERT INTO connections (user_id, provider, provider_user_id, display_name, access_token, refresh_token, expires_at, scope, demo, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("u1", "youtube", "p1", "Old account", stored, null, null, null, first.db.now());
    const salt = fs.readFileSync(saltFile(dir));

    // The database is restored somewhere without its salt, and starts.
    fs.rmSync(saltFile(dir));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = await restart(dir);
    const untouched = second.db
      .getDb()
      .prepare("SELECT access_token FROM connections WHERE user_id = ?")
      .get("u1") as { access_token: string };
    expect(untouched.access_token).toBe(stored);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/new token key salt was generated/i);
    warn.mockRestore();

    // The operator finds the salt in the backup and puts it back: nothing was lost.
    fs.writeFileSync(saltFile(dir), salt, { mode: 0o600 });
    const third = await restart(dir);
    const rekeyed = third.db
      .getDb()
      .prepare("SELECT access_token FROM connections WHERE user_id = ?")
      .get("u1") as { access_token: string };
    expect(rekeyed.access_token).not.toBe(stored);
    expect(third.crypto.decrypt(rekeyed.access_token)).toBe("ya29.a-real-access-token");
  });
});
