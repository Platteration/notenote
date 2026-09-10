import crypto from "node:crypto";
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

function keyFrom(material: string): Buffer {
  return crypto.createHash("sha256").update(material).digest();
}

/**
 * A short, non-secret name for a key: the first bytes of a hash *of the key*, which reveals
 * nothing about the key itself (it is a hash of a hash of the secret) but is enough to tell
 * two keys apart.
 */
function keyId(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

function currentKey(): Buffer {
  return keyFrom(secret());
}

/** Every key this deployment can decrypt with, newest first. */
function decryptionKeys(): Buffer[] {
  return [currentKey(), ...previousSecrets().map(keyFrom)];
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

export function decrypt(payload: string): string {
  const parts = payload.split(".");
  const keys = decryptionKeys();

  if (parts.length === 4) {
    const [id, ivB, tagB, encB] = parts as [string, string, string, string];
    const key = keys.find((k) => keyId(k) === id);
    if (!key) {
      throw new DecryptionError(
        "This value was encrypted with a key this deployment no longer has. Restore the old SESSION_SECRET in PREVIOUS_SESSION_SECRETS, or reconnect the platform.",
      );
    }
    try {
      return open(key, ivB, tagB, encB);
    } catch {
      throw new DecryptionError("Stored value could not be decrypted");
    }
  }

  // Written before ciphertexts named their key: try each key in turn.
  if (parts.length === 3) {
    const [ivB, tagB, encB] = parts as [string, string, string];
    for (const key of keys) {
      try {
        return open(key, ivB, tagB, encB);
      } catch {
        /* try the next key */
      }
    }
    throw new DecryptionError(
      "This value was encrypted with a key this deployment no longer has. Restore the old SESSION_SECRET in PREVIOUS_SESSION_SECRETS, or reconnect the platform.",
    );
  }

  throw new DecryptionError("Malformed ciphertext");
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
