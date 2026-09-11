import { afterEach, describe, expect, it, vi } from "vitest";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_SECRET = "test-secret-for-crypto-tests";

const { DecryptionError, decrypt, encrypt, isDecryptable, upgradeCiphertext } = await import("@/lib/crypto");

const ORIGINAL = "test-secret-for-crypto-tests";
const ROTATED = "a-completely-different-secret-value";

afterEach(() => {
  process.env.SESSION_SECRET = ORIGINAL;
  delete process.env.PREVIOUS_SESSION_SECRETS;
});

/** The pre-key-id format, written the way the old code wrote it: iv.tag.ciphertext. */
function legacyCiphertext(secret: string, plain: string): string {
  const key = nodeCrypto.createHash("sha256").update(secret).digest();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

describe("token encryption", () => {
  it("round-trips a value", () => {
    expect(decrypt(encrypt("an-access-token"))).toBe("an-access-token");
  });

  it("names the key that made it, without revealing anything about the key", () => {
    const parts = encrypt("x").split(".");
    expect(parts).toHaveLength(4);
    const id = parts[0];

    process.env.SESSION_SECRET = ROTATED;
    expect(encrypt("x").split(".")[0]).not.toBe(id);

    // The id is a hash of the key, which is itself a hash of the secret: neither is in it.
    expect(id).not.toContain(ORIGINAL.slice(0, 8));
    expect(nodeCrypto.createHash("sha256").update(ORIGINAL).digest("base64url")).not.toContain(id);
  });

  it("reads ciphertexts written before the key id existed", () => {
    expect(decrypt(legacyCiphertext(ORIGINAL, "old-token"))).toBe("old-token");
  });
});

/**
 * What a copy of the database file is worth on its own.
 *
 * The threat this encryption exists for is a stolen file — a leaked backup, a world-readable
 * DATA_DIR — held by someone without the server's environment. The key used to be a bare sha256
 * of SESSION_SECRET and the key id stored beside every ciphertext was a sha256 of that key, so a
 * candidate secret could be tested with two hash compressions and no AES: a 21-character secret
 * fell in 148 ms over 14,143 candidates, against 50 ms *per guess* for the password hashes in
 * the same file.
 */
describe("what the stored ciphertext gives away about SESSION_SECRET", () => {
  /** The verifier the old format handed an offline attacker, computed the way it was computed. */
  const oldVerifier = (material: string) =>
    nodeCrypto
      .createHash("sha256")
      .update(nodeCrypto.createHash("sha256").update(material).digest())
      .digest("base64url")
      .slice(0, 8);

  it("does not let a candidate be tested with a hash", () => {
    const id = encrypt("an-access-token").split(".")[0];
    // Derived from the old code rather than from the new: this is the exact check the cracking
    // script made, and it has to stop matching.
    expect(id).not.toBe(oldVerifier(ORIGINAL));
  });

  it("is not opened by a bare hash of the secret either", () => {
    const [, iv, tag, enc] = encrypt("an-access-token").split(".");
    const open = () => {
      const d = nodeCrypto.createDecipheriv("aes-256-gcm", nodeCrypto.createHash("sha256").update(ORIGINAL).digest(), Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
    };
    expect(open).toThrow();
  });

  it("costs a candidate real work, not a hash", () => {
    // A secret this process has not derived before, so nothing is cached. sha256 of it is
    // microseconds; the point of the KDF is that this is not.
    const fresh = `unseen-secret-${Math.random()}`;
    process.env.SESSION_SECRET = fresh;
    const started = process.hrtime.bigint();
    encrypt("x");
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeGreaterThan(20);
  });

  it("stretches with a per-deployment salt, so work against one install buys nothing against another", async () => {
    const ids: string[] = [];
    const dirs = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "ds-salt-")));
    try {
      for (const dir of dirs) {
        // A fresh module instance is a fresh process as far as the salt file is concerned.
        vi.resetModules();
        process.env.DATA_DIR = dir;
        const fresh = await import("@/lib/crypto");
        ids.push(fresh.encrypt("an-access-token").split(".")[0]);
        const salt = path.join(dir, "token-key.salt");
        expect(fs.existsSync(salt)).toBe(true);
        // The salt is not secret, but it lives beside the database and inherits its rules.
        expect(fs.statSync(salt).mode & 0o077).toBe(0);
      }
      // Same secret, different deployment: different key, so no table is reusable.
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      delete process.env.DATA_DIR;
      vi.resetModules();
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Migrating what is already stored. A ciphertext written under the old derivation still opens —
 * otherwise upgrading would strand every existing connection — but it does not stay that way:
 * `lib/db.ts` re-keys it when the database is opened, and this is the part that does the work.
 */
describe("upgrading a stored ciphertext", () => {
  it("re-keys a value written under the old derivation, without changing what it says", () => {
    const stored = legacyCiphertext(ORIGINAL, "an-access-token");
    const upgraded = upgradeCiphertext(stored);
    expect(upgraded).not.toBeNull();
    expect(decrypt(upgraded!)).toBe("an-access-token");
    expect(upgraded!.split(".")).toHaveLength(4);
  });

  it("leaves a current value alone, and anything no key opens", () => {
    expect(upgradeCiphertext(encrypt("already-current"))).toBeNull();
    expect(upgradeCiphertext(legacyCiphertext("a-secret-this-deployment-never-had", "x"))).toBeNull();
    expect(upgradeCiphertext("nonsense")).toBeNull();
  });
});

describe("rotating SESSION_SECRET", () => {
  it("says what happened, instead of failing as if the data were corrupt", () => {
    const stored = encrypt("an-access-token");
    process.env.SESSION_SECRET = ROTATED;

    expect(isDecryptable(stored)).toBe(false);
    const err = (() => {
      try {
        decrypt(stored);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(DecryptionError);
    expect(err!.message).toMatch(/PREVIOUS_SESSION_SECRETS|reconnect/i);
  });

  it("keeps working when the old secret is carried in PREVIOUS_SESSION_SECRETS", () => {
    const stored = encrypt("an-access-token");
    const legacy = legacyCiphertext(ORIGINAL, "an-older-token");

    process.env.SESSION_SECRET = ROTATED;
    process.env.PREVIOUS_SESSION_SECRETS = `some-other-retired-secret, ${ORIGINAL}`;

    expect(decrypt(stored)).toBe("an-access-token");
    expect(decrypt(legacy)).toBe("an-older-token");
    expect(isDecryptable(stored)).toBe(true);
    // New writes use the current key, not a retired one.
    expect(decrypt(encrypt("fresh"))).toBe("fresh");
  });

  it("refuses a tampered or malformed value as a decryption failure, not a crash", () => {
    const stored = encrypt("an-access-token");
    const [id, iv, tag] = stored.split(".");
    expect(() => decrypt(`${id}.${iv}.${tag}.${Buffer.from("forged").toString("base64url")}`)).toThrow(DecryptionError);
    expect(() => decrypt("nonsense")).toThrow(DecryptionError);
    expect(isDecryptable("nonsense")).toBe(false);
  });
});
