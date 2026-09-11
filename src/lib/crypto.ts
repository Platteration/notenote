import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * scrypt is deliberately expensive — around 50-150ms per call. The synchronous form spends
 * that entirely on the event loop, freezing every other request in the process, so password
 * work always goes through the callback form, which runs on the threadpool.
 *
 * The token key below is the one deliberate exception, and it is one because of when it is
 * paid rather than because it is cheap: it is derived once per configured secret per process,
 * pre-paid at boot by `prepareTokenKey`, and it has to be usable from the synchronous paths
 * that read and write rows. Nothing per-request and nothing per-sign-in may use the
 * synchronous form.
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

/**
 * What the salt file says about itself, so that it can be *checked* rather than measured.
 *
 * The salt used to be stored as bare base64url and validated by decoding it and looking at the
 * length, which is not a check at all: Node's base64url decoder silently skips everything
 * outside the alphabet, so `# this used to be a salt, someone edited it by hand` decodes to 28
 * bytes and passes. A file that has been edited, truncated or half-restored then reads as a
 * *different* salt rather than as a damaged one — and a deployment that boots with a different
 * salt cannot read any of the tokens the real one was protecting. The label and the checksum
 * make the difference between "this is not the salt" and "this is a salt", which is the
 * difference between a refusal and silent data loss.
 */
const SALT_LABEL = "daily-scroll-token-key-salt-v1";
const SALT_NOTE = [
  "# The Daily Scroll token key salt. Back this file up with the database: the provider tokens",
  "# encrypted under it cannot be read without it. Do not edit it by hand.",
].join("\n");

function saltChecksum(salt: Buffer): string {
  return crypto.createHash("sha256").update(SALT_LABEL).update(salt).digest("base64url").slice(0, 8);
}

function serialiseSalt(salt: Buffer): string {
  return `${SALT_NOTE}\n${SALT_LABEL} ${salt.toString("base64url")} ${saltChecksum(salt)}\n`;
}

/** base64url and nothing else: `Buffer.from` on its own would drop whatever it did not like. */
function decodeSalt(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const salt = Buffer.from(text, "base64url");
  return salt.length >= SALT_BYTES ? salt : null;
}

interface ParsedSalt {
  salt: Buffer;
  /** Whether the file it came from says what it is, or is the bare value an older build wrote. */
  described: boolean;
}

/** The salt a file holds, or null when what it holds is not one. */
function parseSalt(contents: string): ParsedSalt | null {
  const lines = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length !== 1) return null;
  const parts = lines[0]!.split(/\s+/);
  // A salt written before the file described itself. Still a salt, and now strictly decoded.
  if (parts.length === 1) {
    const salt = decodeSalt(parts[0]!);
    return salt ? { salt, described: false } : null;
  }
  if (parts.length !== 3 || parts[0] !== SALT_LABEL) return null;
  const salt = decodeSalt(parts[1]!);
  return salt && parts[2] === saltChecksum(salt) ? { salt, described: true } : null;
}

interface StoredSalt {
  salt: Buffer;
  /** Whether this process generated it rather than finding one. */
  created: boolean;
  file: string;
}

let cachedSalt: StoredSalt | null = null;

function saltPath(): string {
  const dir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dir, SALT_FILE);
}

/**
 * The salt on disk, or null when there is none.
 *
 * A file that exists but cannot be read, and a file that exists and is not a salt, are two
 * different operator problems and say so: both used to come out as "Could not write the token
 * key salt", which sends someone to check directory permissions that are fine.
 */
function readSalt(file: string): ParsedSalt | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No file here, or no directory to hold one: either way there is nothing to read, and the
    // write below is what will say whether the place it should live is usable.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`Could not read the token key salt at ${file} (${code ?? (err as Error).message}).`);
  }
  const salt = parseSalt(contents);
  if (!salt) {
    throw new Error(
      `The file at ${file} is not a token key salt (${contents.length} characters, no usable salt in them). ` +
        "Nothing has been rewritten. Restore the file from backup, or move it aside to have a new salt written — " +
        "the provider tokens encrypted under the old one cannot be read without it and those platforms have to be reconnected.",
    );
  }
  return salt;
}

/**
 * Write a new salt, completely, before anything can read it.
 *
 * `writeFileSync(..., { flag: "wx" })` is open-then-write: a second process starting at the same
 * moment could see the name before the contents and refuse to boot over an empty file. Writing
 * to a temporary name and linking it into place publishes a finished file in one step, and
 * `link` still refuses a name that exists, so the loser of the race reads what the winner wrote.
 */
function writeSalt(file: string): Buffer {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, serialiseSalt(crypto.randomBytes(SALT_BYTES)), { mode: 0o600 });
    try {
      fs.linkSync(temporary, file);
    } catch {
      // A filesystem with no hard links: rename is still atomic, it just cannot refuse a name.
      if (!fs.existsSync(file)) fs.renameSync(temporary, file);
    }
  } catch (err) {
    throw new Error(`Could not write the token key salt to ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* renamed into place, or never written */
    }
  }
  // Whatever is on disk is what every later boot will read, so it is what this one uses too.
  const stored = readSalt(file);
  if (!stored) throw new Error(`Could not write the token key salt to ${file}`);
  return stored.salt;
}

/**
 * Rewrite a bare salt in the form that describes itself, keeping the same salt.
 *
 * Best effort and done once: the value does not change, so a file that cannot be rewritten is
 * not a problem — it just keeps the older form, in which an edit to it reads as a different
 * salt instead of being refused. Renaming a finished file over it means the file on disk is
 * only ever one salt or the other, never half of one.
 */
function describeSaltFile(file: string, salt: Buffer): void {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, serialiseSalt(salt), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never written */
    }
  }
}

/**
 * The salt the token key is stretched with.
 *
 * Not a secret — it lives beside the database it protects — but per deployment, so work done
 * against one install buys nothing against another and nothing can be pre-computed before the
 * install exists. It is also not recoverable: back it up with the database file, or the tokens
 * stretched under it have to be reconnected. `src/instrumentation.ts` derives the key at boot
 * so a DATA_DIR this cannot be written to says so there rather than mid-request, and says so
 * too when a new salt has just been generated beside a database that already existed.
 */
function storedSalt(): StoredSalt {
  if (cachedSalt) return cachedSalt;
  const file = saltPath();
  const existing = readSalt(file);
  if (existing && !existing.described) describeSaltFile(file, existing.salt);
  cachedSalt = existing ? { salt: existing.salt, created: false, file } : { salt: writeSalt(file), created: true, file };
  return cachedSalt;
}

function keySalt(): Buffer {
  return storedSalt().salt;
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

export interface TokenKeyState {
  /** Where the salt lives, for a message that has to name it. */
  saltFile: string;
  /** Whether this process generated the salt rather than finding one already there. */
  saltCreated: boolean;
}

/**
 * Derive every key this deployment can decrypt with, so the cost and any DATA_DIR problem land
 * at boot.
 *
 * Every configured secret, not just the current one: a stretched key costs a third of a second
 * and `decrypt` cannot know in advance which one a stored row names, so a secret left out here
 * is a secret paid for on the event loop by whichever request first meets a row that needs it.
 */
export function prepareTokenKey(): TokenKeyState {
  for (const material of decryptionSecrets()) keyFrom(material);
  return tokenKeyState();
}

/** Where the salt is and whether it was just made, resolving it but deriving nothing. */
export function tokenKeyState(): TokenKeyState {
  const { file, created } = storedSalt();
  return { saltFile: file, saltCreated: created };
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

/**
 * The stretched key a ciphertext names, or none.
 *
 * Derived one secret at a time and no further than the one that answers. Deriving every
 * configured key and *then* filtering by the id — which is what this used to do — pays a KDF
 * per retired secret for a row the current key opens: four secrets in PREVIOUS_SESSION_SECRETS,
 * the documented recovery configuration after a leak, cost 942 ms of frozen event loop on the
 * first decrypt.
 */
function stretchedKeyFor(id: string): Buffer[] {
  for (const material of decryptionSecrets()) {
    const key = keyFrom(material);
    if (keyId(key) === id) return [key];
  }
  return [];
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
    // here as well as one written after it. Each is matched on the id before the key it needs is
    // derived, rather than after.
    const keys = [...stretchedKeyFor(id), ...legacyKeys().filter((k) => legacyKeyId(k) === id)];
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
  // try each key in turn. There is no id to match on, so the cheap derivation is tried first and
  // the stretched keys are derived one at a time rather than all of them before the first try.
  if (parts.length === 3) {
    const [ivB, tagB, encB] = parts as [string, string, string];
    const tryKey = (key: Buffer): string | null => {
      try {
        return open(key, ivB, tagB, encB);
      } catch {
        return null;
      }
    };
    for (const key of legacyKeys()) {
      const plain = tryKey(key);
      if (plain !== null) return plain;
    }
    for (const material of decryptionSecrets()) {
      const plain = tryKey(keyFrom(material));
      if (plain !== null) return plain;
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
