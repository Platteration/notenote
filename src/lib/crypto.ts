import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * scrypt is deliberately expensive — around 50-150ms per call. The synchronous form spends
 * that entirely on the event loop, freezing every other request in the process, so password
 * work always goes through the callback form, which runs on the threadpool.
 */
const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * The development fallback.
 *
 * This string is in the repository, so sha256 of it is a publicly known AES key. It exists so
 * that `npm run dev` works with no .env at all; `src/instrumentation.ts` says so loudly at
 * boot, because a dev server exposed through a tunnel for OAuth callback testing holds real
 * platform tokens under a key everybody has.
 */
export const DEV_FALLBACK_SECRET = "daily-scroll-dev-secret-change-me";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set (>= 16 chars) in production");
  }
  return DEV_FALLBACK_SECRET;
}

/**
 * Secrets accepted when *decrypting*, so that rotating SESSION_SECRET — the thing an operator
 * should do after a suspected leak — does not strand every stored access and refresh token.
 * Comma-separated; each ciphertext names the key that made it, so the right one is chosen
 * rather than guessed.
 */
function previousSecrets(): string[] {
  return (process.env.PREVIOUS_SESSION_SECRETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 16);
}

/**
 * scrypt parameters for the token key.
 *
 * SESSION_SECRET is a string an operator chose, and this key used to be a single sha256 of it:
 * about 0.005 ms to test a candidate offline, against 50 ms for one of the password hashes in
 * the same file. Anyone holding a copy of the database held the key id beside every ciphertext
 * as a free verifier, so a wordlist recovered a 21-character secret in 148 ms and opened every
 * platform access and refresh token in the file. Stretching costs a guess what a password guess
 * costs. N is one step above the password parameters because this is paid once per process and
 * per secret, not once per sign-in.
 */
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

/** The file in DATA_DIR holding the salt; created on first use, never rewritten. */
const SALT_FILE = "token-key.salt";
const SALT_BYTES = 16;

let cachedSalt: Buffer | null = null;

/**
 * The salt the token key is stretched with.
 *
 * Not a secret — it lives beside the database it protects — but per deployment, so work done
 * against one install buys nothing against another and nothing can be pre-computed before the
 * install exists. It is also not recoverable: back it up with the database file, or the tokens
 * stretched under it have to be reconnected. `src/instrumentation.ts` derives the key at boot
 * so a DATA_DIR this cannot be written to says so there rather than mid-request.
 */
function keySalt(): Buffer {
  if (cachedSalt) return cachedSalt;
  const dir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const file = path.join(dir, SALT_FILE);
  const read = (): Buffer | null => {
    try {
      const raw = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
      return raw.length >= SALT_BYTES ? raw : null;
    } catch {
      return null;
    }
  };
  let salt = read();
  if (!salt) {
    salt = crypto.randomBytes(SALT_BYTES);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      // `wx` so two processes starting at once cannot each write their own salt: the loser
      // reads what the winner wrote.
      fs.writeFileSync(file, `${salt.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      salt = read();
      if (!salt) throw new Error(`Could not write the token key salt to ${file}`);
    }
  }
  cachedSalt = salt;
  return salt;
}

/** Stretching is expensive on purpose, so each distinct secret is derived once per process. */
const keyCache = new Map<string, Buffer>();

function keyFrom(material: string): Buffer {
  let key = keyCache.get(material);
  if (!key) {
    key = crypto.scryptSync(material, keySalt(), 32, KDF);
    keyCache.set(material, key);
  }
  return key;
}

/** Derive the current key now, so the cost and any DATA_DIR problem land at boot. */
export function prepareTokenKey(): void {
  currentKey();
}

const KEY_ID_LABEL = "daily-scroll token key id";

/**
 * A short, non-secret name for a key, so a ciphertext can say which one made it.
 *
 * An HMAC *under* the key, not a hash *of* it. A hash of the key was a 48-bit verifier for
 * SESSION_SECRET stored beside every ciphertext, testable with two sha256 compressions and no
 * AES at all; under the HMAC a candidate cannot be tested without first paying for the KDF.
 */
function keyId(key: Buffer): string {
  return crypto.createHmac("sha256", key).update(KEY_ID_LABEL).digest("base64url").slice(0, 8);
}

/**
 * The superseded derivation: a bare sha256 of the secret, named by a sha256 of that key.
 *
 * Kept for reading only. Ciphertexts written this way are re-encrypted under the current key by
 * the migration in `lib/db.ts`, which is what actually retires it; until a database has been
 * opened by this version, its rows still need it.
 */
function legacyKeyFrom(material: string): Buffer {
  return crypto.createHash("sha256").update(material).digest();
}

function legacyKeyId(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

function currentKey(): Buffer {
  return keyFrom(secret());
}

/** Every secret this deployment can decrypt with, newest first. */
function decryptionSecrets(): string[] {
  return [secret(), ...previousSecrets()];
}

/** Every key this deployment can decrypt with, newest first. */
function decryptionKeys(): Buffer[] {
  return decryptionSecrets().map(keyFrom);
}

function legacyKeys(): Buffer[] {
  return decryptionSecrets().map(legacyKeyFrom);
}

/**
 * A stored ciphertext that no configured key can open.
 *
 * Distinguished from corruption on purpose: rotating SESSION_SECRET without carrying the old
 * one in PREVIOUS_SESSION_SECRETS used to surface as "Unsupported state or unable to
 * authenticate data" in a feed error, with the connection still showing as live.
 */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * AES-256-GCM encryption for provider tokens at rest.
 * Output: keyId.iv.tag.ciphertext (base64url). Ciphertexts written before the key id existed
 * have three parts and are still read.
 */
export function encrypt(plain: string): string {
  const key = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [keyId(key), ...[iv, tag, enc].map((b) => b.toString("base64url"))].join(".");
}

function open(key: Buffer, ivB: string, tagB: string, encB: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const NO_KEY =
  "This value was encrypted with a key this deployment no longer has. Restore the old SESSION_SECRET in PREVIOUS_SESSION_SECRETS, or reconnect the platform.";

export function decrypt(payload: string): string {
  const parts = payload.split(".");

  if (parts.length === 4) {
    const [id, ivB, tagB, encB] = parts as [string, string, string, string];
    // Both derivations answer to a key id, so a row written before the key was stretched opens
    // here as well as one written after it.
    const keys = [
      ...decryptionKeys().filter((k) => keyId(k) === id),
      ...legacyKeys().filter((k) => legacyKeyId(k) === id),
    ];
    if (keys.length === 0) throw new DecryptionError(NO_KEY);
    for (const key of keys) {
      try {
        return open(key, ivB, tagB, encB);
      } catch {
        /* try the next key */
      }
    }
    throw new DecryptionError("Stored value could not be decrypted");
  }

  // Written before ciphertexts named their key, and therefore before the key was stretched:
  // try each key in turn.
  if (parts.length === 3) {
    const [ivB, tagB, encB] = parts as [string, string, string];
    for (const key of [...legacyKeys(), ...decryptionKeys()]) {
      try {
        return open(key, ivB, tagB, encB);
      } catch {
        /* try the next key */
      }
    }
    throw new DecryptionError(NO_KEY);
  }

  throw new DecryptionError("Malformed ciphertext");
}

/** Whether a stored value was written under the superseded, unstretched derivation. */
function isLegacyCiphertext(payload: string): boolean {
  const parts = payload.split(".");
  if (parts.length === 3) return true;
  return parts.length === 4 && legacyKeys().some((k) => legacyKeyId(k) === parts[0]);
}

/**
 * Re-encrypt a value written under the superseded derivation, or null when there is nothing to
 * do: it is already current, or no configured secret opens it.
 *
 * Nothing is lost by returning null for a value this deployment cannot read — a secret rotated
 * away without PREVIOUS_SESSION_SECRETS — because the row is left exactly as it was and still
 * opens once the old secret is carried again.
 */
export function upgradeCiphertext(payload: string): string | null {
  try {
    if (!isLegacyCiphertext(payload)) return null;
    return encrypt(decrypt(payload));
  } catch {
    // Including a deployment with no usable secret at all: the migration that calls this must
    // not be the thing that fails to open the database.
    return null;
  }
}

/** Whether a stored ciphertext can still be opened, without caring what is inside it. */
export function isDecryptable(payload: string): boolean {
  try {
    decrypt(payload);
    return true;
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * The stored form of a session token.
 *
 * The browser presents 32 bytes of CSPRNG output, and that value used to be the primary key of
 * the sessions table — so anyone who could read the database file (a leaked backup, a
 * world-readable DATA_DIR, a future file-read bug) could impersonate every account for up to
 * thirty days, while the passwords in the same file were behind scrypt. Storing a hash makes
 * a stolen file a list of useless hashes.
 *
 * A plain sha256 is the right hash here, unlike for passwords: there is no low-entropy secret
 * to grind, nothing is reused across sites, and this runs on every authenticated request.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB, hashB] = stored.split("$");
  if (algo !== "scrypt" || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, "base64url");
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, Buffer.from(saltB, "base64url"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * A real hash of a value nobody knows, so a sign-in attempt for an account that does not
 * exist can spend the same time as one that does. Without it the response is roughly ten
 * times faster for an unknown address, which tells an attacker exactly which addresses are
 * registered and makes the deliberately vague error message pointless.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(crypto.randomBytes(32).toString("hex"));
  return decoy;
}

/** PKCE helpers (RFC 7636). */
export function pkceVerifier(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
