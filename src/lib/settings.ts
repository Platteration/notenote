import { getDb, now, type SettingsRow } from "./db";
import { UserFacingError } from "./errors";
import { isReduceMotion, migrateReduceMotion, type ReduceMotion } from "./motion";
import { isTheme, THEMES, type Theme } from "./theme";
import { canonicalTimeZone, parseWindowStart } from "./window";

export { THEMES };
export type { ReduceMotion, Theme };

export const DEFAULT_WINDOW_START = "20:00";
export const DEFAULT_FEED_SIZE = 40;
export const MIN_FEED_SIZE = 10;
export const MAX_FEED_SIZE = 80;

/**
 * Appearance and experience preferences. These never change *what* is in the feed or how
 * long it lasts, only how it feels — so they are safe to expand freely.
 */
export interface Prefs {
  theme: Theme;
  /**
   * Turn off gradient animation, smooth scrolling and transitions: `on` and `off` literally,
   * `system` as the device asks. Builds before this one stored a boolean; parsePrefs migrates it.
   */
  reduceMotion: ReduceMotion;
  /** Light taps as clips pass, a longer pulse in the final minute (mobile only). */
  haptics: boolean;
  /** A soft chime when the hour opens and a lower tone when it closes. */
  sound: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: "system", reduceMotion: "system", haptics: true, sound: false };

export interface Settings {
  timezone: string;
  windowStart: string;
  feedSize: number;
  prefs: Prefs;
}

/**
 * The `prefs` column, validated on the way out of the database.
 *
 * Field by field: a value the reader cannot use falls back to its own default and never takes
 * the rest of the record with it. Enum fields go through own-property lookups (`isTheme`,
 * `isReduceMotion`), because a row is whatever was written to it. This is also where the shape
 * of a value migrates: the boolean `reduceMotion` an older build stored becomes the three-state
 * one here, so every read site sees one shape and nothing is rewritten until the user next saves.
 */
export function parsePrefs(raw: string | null | undefined): Prefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PREFS };
    const parsed = value as Partial<Record<keyof Prefs, unknown>>;
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_PREFS.theme,
      reduceMotion: migrateReduceMotion(parsed.reduceMotion, DEFAULT_PREFS.reduceMotion),
      haptics: typeof parsed.haptics === "boolean" ? parsed.haptics : DEFAULT_PREFS.haptics,
      sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULT_PREFS.sound,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function getSettings(userId: string): Settings {
  const row = getDb().prepare("SELECT * FROM settings WHERE user_id = ?").get(userId) as SettingsRow | undefined;
  if (!row) {
    return { timezone: "UTC", windowStart: DEFAULT_WINDOW_START, feedSize: DEFAULT_FEED_SIZE, prefs: { ...DEFAULT_PREFS } };
  }
  return { timezone: row.timezone, windowStart: row.window_start, feedSize: row.feed_size, prefs: parsePrefs(row.prefs) };
}

export function saveSettings(userId: string, input: Partial<Omit<Settings, "prefs">> & { prefs?: Partial<Prefs> }): Settings {
  const current = getSettings(userId);
  const next: Settings = { ...current, prefs: { ...current.prefs } };
  if (input.timezone !== undefined) {
    // Stored in the platform's own spelling: Intl accepts every case permutation of a zone name,
    // and each distinct spelling that reaches window.ts is a formatter cached for the life of
    // the process. One 120-byte settings write should not be able to retain 28 KB of server
    // memory, so the collapsing happens here, where the value is written.
    const zone = canonicalTimeZone(input.timezone);
    if (!zone) throw new UserFacingError("Unknown timezone");
    next.timezone = zone;
  }
  if (input.windowStart !== undefined) {
    const parsed = parseWindowStart(input.windowStart);
    if (!parsed) throw new UserFacingError("Window start must be HH:MM");
    next.windowStart = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  }
  if (input.feedSize !== undefined) {
    const n = Math.round(Number(input.feedSize));
    if (!Number.isFinite(n) || n < MIN_FEED_SIZE || n > MAX_FEED_SIZE) {
      throw new UserFacingError(`Feed size must be between ${MIN_FEED_SIZE} and ${MAX_FEED_SIZE}`);
    }
    next.feedSize = n;
  }
  if (input.prefs) {
    const p = input.prefs;
    if (p.theme !== undefined) {
      if (!isTheme(p.theme)) throw new UserFacingError("Unknown theme");
      next.prefs.theme = p.theme;
    }
    if (p.reduceMotion !== undefined) {
      // A tab left open across the deploy still sends the old boolean; it means what it meant.
      const value = typeof p.reduceMotion === "boolean" ? migrateReduceMotion(p.reduceMotion, next.prefs.reduceMotion) : p.reduceMotion;
      if (!isReduceMotion(value)) throw new UserFacingError("Unknown reduce motion setting");
      next.prefs.reduceMotion = value;
    }
    for (const key of ["haptics", "sound"] as const) {
      if (p[key] !== undefined) next.prefs[key] = Boolean(p[key]);
    }
  }
  writeSettings(userId, next);
  return next;
}

/**
 * Put the appearance and feedback preferences back to their defaults: the `prefs` record and
 * nothing else. The hour (timezone, window start, feed size) is not a preference, and
 * connections, history and the shelf are the user's data; all of it is left as it is. This
 * record carries no onboarding flag; one that arrives is copied from `current`, not reset.
 */
export function resetPrefs(userId: string): Settings {
  const current = getSettings(userId);
  const next: Settings = { ...current, prefs: { ...DEFAULT_PREFS } };
  writeSettings(userId, next);
  return next;
}

function writeSettings(userId: string, next: Settings): void {
  getDb()
    .prepare(
      `INSERT INTO settings (user_id, timezone, window_start, feed_size, updated_at, prefs) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, window_start = excluded.window_start,
       feed_size = excluded.feed_size, updated_at = excluded.updated_at, prefs = excluded.prefs`,
    )
    .run(userId, next.timezone, next.windowStart, next.feedSize, now(), JSON.stringify(next.prefs));
}
