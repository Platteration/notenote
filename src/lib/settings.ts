import { getDb, now, type SettingsRow } from "./db";
import { isValidTimeZone, parseWindowStart } from "./window";

export const DEFAULT_WINDOW_START = "20:00";
export const DEFAULT_FEED_SIZE = 40;
export const MIN_FEED_SIZE = 10;
export const MAX_FEED_SIZE = 80;

export interface Settings {
  timezone: string;
  windowStart: string;
  feedSize: number;
}

export function getSettings(userId: string): Settings {
  const row = getDb().prepare("SELECT * FROM settings WHERE user_id = ?").get(userId) as SettingsRow | undefined;
  if (!row) return { timezone: "UTC", windowStart: DEFAULT_WINDOW_START, feedSize: DEFAULT_FEED_SIZE };
  return { timezone: row.timezone, windowStart: row.window_start, feedSize: row.feed_size };
}

export function saveSettings(userId: string, input: Partial<Settings>): Settings {
  const current = getSettings(userId);
  const next: Settings = { ...current };
  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) throw new Error("Unknown timezone");
    next.timezone = input.timezone;
  }
  if (input.windowStart !== undefined) {
    const parsed = parseWindowStart(input.windowStart);
    if (!parsed) throw new Error("Window start must be HH:MM");
    next.windowStart = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  }
  if (input.feedSize !== undefined) {
    const n = Math.round(Number(input.feedSize));
    if (!Number.isFinite(n) || n < MIN_FEED_SIZE || n > MAX_FEED_SIZE) {
      throw new Error(`Feed size must be between ${MIN_FEED_SIZE} and ${MAX_FEED_SIZE}`);
    }
    next.feedSize = n;
  }
  getDb()
    .prepare(
      `INSERT INTO settings (user_id, timezone, window_start, feed_size, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, window_start = excluded.window_start,
       feed_size = excluded.feed_size, updated_at = excluded.updated_at`,
    )
    .run(userId, next.timezone, next.windowStart, next.feedSize, now());
  return next;
}
