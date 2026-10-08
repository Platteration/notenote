/**
 * The archive: notes, collections and search over the clips a user saved.
 *
 * Every write names a clip by key and is checked against the user's own saved_items row —
 * never against feeds, which are purged a day after their hour — and never takes clip
 * metadata from the client. Limits live in archive-limits.ts so the UI can show them.
 */
import {
  ARCHIVE_SEARCH_LIMIT,
  MAX_COLLECTION_NAME,
  MAX_COLLECTIONS,
  MAX_NOTE_LENGTH,
  MAX_SEARCH_QUERY,
} from "./archive-limits";
import { newId } from "./crypto";
import { getDb, now } from "./db";
import { UserFacingError } from "./errors";
import { hydrateSaved, readSaved, type SavedItem, type SavedRow } from "./library";
import { PROVIDER_IDS, type ProviderId } from "./providers/types";

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  /** How many saved clips are filed in it. */
  count: number;
}

export interface ArchiveQuery {
  q?: string;
  collectionId?: string;
  provider?: string;
}

const NOT_IN_ARCHIVE = "That clip isn't in your archive";

export function setNote(userId: string, itemKey: string, note: string): SavedItem {
  if (note.length > MAX_NOTE_LENGTH) throw new UserFacingError(`Notes can be up to ${MAX_NOTE_LENGTH} characters`);
  const result = getDb().prepare("UPDATE saved_items SET note = ? WHERE user_id = ? AND item_key = ?").run(note, userId, itemKey);
  if (Number(result.changes) === 0) throw new UserFacingError(NOT_IN_ARCHIVE, 404);
  return readSaved(userId, itemKey)!;
}

function normaliseCollectionName(name: unknown): string {
  if (typeof name !== "string") throw new UserFacingError("A collection needs a name");
  const trimmed = name.trim();
  if (!trimmed) throw new UserFacingError("A collection needs a name");
  if (trimmed.length > MAX_COLLECTION_NAME) throw new UserFacingError(`Collection names can be up to ${MAX_COLLECTION_NAME} characters`);
  return trimmed;
}

/** SQLite's unique-constraint failure, which is how a duplicate name arrives. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { errcode?: number }).errcode === 2067;
}

/** SQLite's foreign-key failure: filing a clip the user has not saved. */
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { errcode?: number }).errcode === 787;
}

const COLLECTION_COLUMNS = `c.id, c.name, c.created_at,
  (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS count`;

type CollectionRow = { id: string; name: string; created_at: number; count: number };
const toCollection = (r: CollectionRow): Collection => ({ id: r.id, name: r.name, createdAt: r.created_at, count: r.count });

export function listCollections(userId: string): Collection[] {
  return (
    getDb()
      .prepare(`SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.user_id = ? ORDER BY c.created_at, c.name`)
      .all(userId) as CollectionRow[]
  ).map(toCollection);
}

export function getCollection(userId: string, collectionId: string): Collection | null {
  const row = getDb()
    .prepare(`SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.user_id = ? AND c.id = ?`)
    .get(userId, collectionId) as CollectionRow | undefined;
  return row ? toCollection(row) : null;
}

function requireCollection(userId: string, collectionId: string): Collection {
  const found = getCollection(userId, collectionId);
  if (!found) throw new UserFacingError("No such collection", 404);
  return found;
}

export function createCollection(userId: string, name: unknown, at: number = now()): Collection {
  const clean = normaliseCollectionName(name);
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS c FROM collections WHERE user_id = ?").get(userId) as { c: number }).c;
  if (count >= MAX_COLLECTIONS) throw new UserFacingError(`You can have up to ${MAX_COLLECTIONS} collections. Delete one first.`);
  const id = newId();
  try {
    db.prepare("INSERT INTO collections (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, userId, clean, at);
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserFacingError(`You already have a collection called ${clean}`);
    throw err;
  }
  return requireCollection(userId, id);
}

export function renameCollection(userId: string, collectionId: string, name: unknown): Collection {
  requireCollection(userId, collectionId);
  const clean = normaliseCollectionName(name);
  try {
    getDb().prepare("UPDATE collections SET name = ? WHERE id = ? AND user_id = ?").run(clean, collectionId, userId);
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserFacingError(`You already have a collection called ${clean}`);
    throw err;
  }
  return requireCollection(userId, collectionId);
}

/** Removes the collection and its memberships; the clips and their notes stay in the archive. */
export function deleteCollection(userId: string, collectionId: string): boolean {
  return Number(getDb().prepare("DELETE FROM collections WHERE id = ? AND user_id = ?").run(collectionId, userId).changes) > 0;
}

export function addToCollection(userId: string, collectionId: string, itemKey: string, at: number = now()): SavedItem {
  requireCollection(userId, collectionId);
  try {
    getDb()
      .prepare("INSERT OR IGNORE INTO collection_items (user_id, collection_id, item_key, added_at) VALUES (?, ?, ?, ?)")
      .run(userId, collectionId, itemKey, at);
  } catch (err) {
    // The composite foreign key onto saved_items: the clip is not in this user's archive.
    if (isForeignKeyViolation(err)) throw new UserFacingError(NOT_IN_ARCHIVE, 404);
    throw err;
  }
  return readSaved(userId, itemKey)!;
}

export function removeFromCollection(userId: string, collectionId: string, itemKey: string): SavedItem {
  requireCollection(userId, collectionId);
  getDb().prepare("DELETE FROM collection_items WHERE user_id = ? AND collection_id = ? AND item_key = ?").run(userId, collectionId, itemKey);
  const saved = readSaved(userId, itemKey);
  if (!saved) throw new UserFacingError(NOT_IN_ARCHIVE, 404);
  return saved;
}

/**
 * Search the archive: title, creator, handle, the user's note and the names of the collections
 * a clip is filed in, optionally within one collection and one platform. Newest saves first,
 * at most ARCHIVE_SEARCH_LIMIT of them.
 *
 * Only named fields are matched, never the stored JSON as a whole (demo posters are SVG data
 * URIs, which would match nearly anything). A field matches when it contains the query, with
 * case folded for ASCII letters only: SQLite's lower() folds nothing else, as its LIKE does not.
 * A row whose stored copy is not valid JSON is skipped, because json_extract on it would fail
 * the whole query. If archives outgrow this, FTS5 is the upgrade path where the deployed
 * node:sqlite build includes it (Node 22.22 with SQLite 3.51 did when this was written).
 *
 * `instr`, not `LIKE '%q%'`. Notes and the query are both the user's own text, and LIKE's `%`
 * walks the pattern from every position of the field again: a query that agrees with a note
 * until its last character costs the note's length times the query's, for every clip. One search
 * of a full archive of such notes held the server's only thread for three seconds (node:sqlite
 * is synchronous), and a search can be sent as often as anyone likes. instr compares with
 * memcmp at each position instead: a fifth of a second for the same archive. It has no
 * wildcards either, so `%` and `_` are the characters they are with nothing to escape.
 */
export function searchSaved(userId: string, query: ArchiveQuery): SavedItem[] {
  const q = (query.q ?? "").trim();
  if (q.length > MAX_SEARCH_QUERY) throw new UserFacingError(`Search terms can be up to ${MAX_SEARCH_QUERY} characters`);
  const provider = query.provider || undefined;
  if (provider !== undefined && !(PROVIDER_IDS as readonly string[]).includes(provider)) throw new UserFacingError("Unknown platform");
  if (query.collectionId) requireCollection(userId, query.collectionId);

  const where = ["s.user_id = ?", "json_valid(s.item_json)"];
  const args: Array<string | number> = [userId];
  if (q) {
    where.push(`(instr(lower(json_extract(s.item_json, '$.title')), lower(?)) > 0
      OR instr(lower(json_extract(s.item_json, '$.creator')), lower(?)) > 0
      OR instr(lower(json_extract(s.item_json, '$.creatorHandle')), lower(?)) > 0
      OR instr(lower(s.note), lower(?)) > 0
      OR s.item_key IN (SELECT ci.item_key FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                        WHERE ci.user_id = ? AND instr(lower(c.name), lower(?)) > 0))`);
    args.push(q, q, q, q, userId, q);
  }
  if (provider) {
    where.push("json_extract(s.item_json, '$.provider') = ?");
    args.push(provider as ProviderId);
  }
  if (query.collectionId) {
    where.push("s.item_key IN (SELECT item_key FROM collection_items WHERE user_id = ? AND collection_id = ?)");
    args.push(userId, query.collectionId);
  }
  const rows = getDb()
    .prepare(`SELECT s.item_key, s.item_json, s.saved_at, s.note FROM saved_items s WHERE ${where.join(" AND ")} ORDER BY s.saved_at DESC LIMIT ?`)
    .all(...args, ARCHIVE_SEARCH_LIMIT) as unknown as SavedRow[];
  return hydrateSaved(userId, rows);
}

/** Saved clips that carry a note or sit in a collection: removing one of these asks first. */
export function annotatedKeys(userId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT item_key FROM saved_items WHERE user_id = ?
           AND (note <> '' OR item_key IN (SELECT item_key FROM collection_items WHERE user_id = ?))`,
      )
      .all(userId, userId) as Array<{ item_key: string }>
  ).map((r) => r.item_key);
}
