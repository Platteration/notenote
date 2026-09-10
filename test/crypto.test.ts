import { afterEach, describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";

process.env.SESSION_SECRET = "test-secret-for-crypto-tests";

const { DecryptionError, decrypt, encrypt, isDecryptable } = await import("@/lib/crypto");

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
