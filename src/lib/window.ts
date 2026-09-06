/**
 * The Daily Scroll is open for exactly one hour per local day.
 * All of the maths here is timezone-aware using the Intl API only.
 */

export const WINDOW_MINUTES = 60;

export interface DailyWindow {
  /** Local calendar day the window belongs to, e.g. "2026-09-06". */
  dayKey: string;
  /** Whether `now` falls inside [opensAt, closesAt). */
  isOpen: boolean;
  /** Absolute instant (ms since epoch) at which the window opens for `dayKey`. */
  opensAt: number;
  /** Absolute instant at which the window closes for `dayKey`. */
  closesAt: number;
  /** Instant of the next opening (today's if still ahead, otherwise tomorrow's). */
  nextOpensAt: number;
  /** Instant of the closing that follows `nextOpensAt`. */
  nextClosesAt: number;
  secondsUntilOpen: number;
  secondsUntilClose: number;
  timezone: string;
  windowStart: string;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Break an instant into wall-clock components in the given zone. */
export function wallClock(instant: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC (ms) at `instant`. */
function tzOffsetMs(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to an absolute instant (ms). Handles DST edges. */
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naive - tzOffsetMs(naive, timeZone);
  // A second pass corrects guesses that landed on the wrong side of a DST transition.
  const corrected = naive - tzOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return guess;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseWindowStart(value: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function dayKeyOf(w: { year: number; month: number; day: number }): string {
  const mm = String(w.month).padStart(2, "0");
  const dd = String(w.day).padStart(2, "0");
  return `${w.year}-${mm}-${dd}`;
}

function addDays(year: number, month: number, day: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Compute the state of the daily window at `nowMs` for a user whose window starts at
 * `windowStart` ("HH:MM") local time in `timeZone`.
 *
 * The "day" a window belongs to is the local calendar day of its opening time. If the
 * window is currently open we report that day; otherwise we report the *next* window.
 */
export function computeWindow(
  nowMs: number,
  timeZone: string,
  windowStart: string,
  windowMinutes: number = WINDOW_MINUTES,
): DailyWindow {
  const start = parseWindowStart(windowStart) ?? { hour: 20, minute: 0 };
  const durationMs = windowMinutes * 60 * 1000;
  const today = wallClock(nowMs, timeZone);

  // Candidate windows: yesterday's (in case it spans midnight and is still open), today's, tomorrow's.
  const candidates = [-1, 0, 1].map((delta) => {
    const d = addDays(today.year, today.month, today.day, delta);
    const opensAt = zonedTimeToInstant(d.year, d.month, d.day, start.hour, start.minute, timeZone);
    return { dayKey: dayKeyOf(d), opensAt, closesAt: opensAt + durationMs };
  });

  const open = candidates.find((c) => nowMs >= c.opensAt && nowMs < c.closesAt);
  const upcoming = candidates.find((c) => c.opensAt > nowMs) ?? candidates[2];

  const current = open ?? upcoming;
  const next = open ? (candidates.find((c) => c.opensAt > open.opensAt) ?? upcoming) : upcoming;

  return {
    dayKey: current.dayKey,
    isOpen: Boolean(open),
    opensAt: current.opensAt,
    closesAt: current.closesAt,
    nextOpensAt: next.opensAt,
    nextClosesAt: next.closesAt,
    secondsUntilOpen: open ? 0 : Math.max(0, Math.ceil((current.opensAt - nowMs) / 1000)),
    secondsUntilClose: open ? Math.max(0, Math.ceil((current.closesAt - nowMs) / 1000)) : 0,
    timezone: timeZone,
    windowStart: `${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}`,
  };
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}
