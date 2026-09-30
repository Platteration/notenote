/**
 * The archive's limits, kept import-free so client components can read them (for maxLength and
 * counters) without pulling the database layer into the browser bundle. Each is checked on the
 * server before the write it bounds, and a test reaches each one.
 */

/** Characters in one clip's note. */
export const MAX_NOTE_LENGTH = 2000;

/** Collections per account. */
export const MAX_COLLECTIONS = 50;

/** Characters in a collection's name, after trimming. */
export const MAX_COLLECTION_NAME = 60;

/** Characters in a search. */
export const MAX_SEARCH_QUERY = 100;

/**
 * Clips per account. A feed holds at most 80 clips a day, so this is two months of saving every
 * clip and years of ordinary use; it exists so the shelf, which is read whole, stays bounded.
 */
export const MAX_SAVED_ITEMS = 5000;

/** Clips returned by one filtered search. */
export const ARCHIVE_SEARCH_LIMIT = 200;
