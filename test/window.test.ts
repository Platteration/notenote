import { describe, expect, it } from "vitest";
import { computeWindow, formatCountdown, parseWindowStart, zonedTimeToInstant } from "@/lib/window";

describe("zonedTimeToInstant", () => {
  it("converts wall clock time in a fixed-offset zone", () => {
    // 2026-03-01 20:00 in Asia/Tokyo (UTC+9) is 11:00 UTC.
    expect(zonedTimeToInstant(2026, 3, 1, 20, 0, "Asia/Tokyo")).toBe(Date.UTC(2026, 2, 1, 11, 0));
  });
  it("handles DST on both sides of the transition", () => {
    // New York is UTC-5 in January and UTC-4 in July.
    expect(zonedTimeToInstant(2026, 1, 15, 20, 0, "America/New_York")).toBe(Date.UTC(2026, 0, 16, 1, 0));
    expect(zonedTimeToInstant(2026, 7, 15, 20, 0, "America/New_York")).toBe(Date.UTC(2026, 6, 16, 0, 0));
  });
});

describe("computeWindow", () => {
  const tz = "Europe/Paris"; // UTC+2 in September
  const opens = Date.UTC(2026, 8, 6, 18, 0); // 20:00 Paris

  it("is locked before the window and reports today's opening", () => {
    const w = computeWindow(opens - 3_600_000, tz, "20:00");
    expect(w.isOpen).toBe(false);
    expect(w.dayKey).toBe("2026-09-06");
    expect(w.opensAt).toBe(opens);
    expect(w.closesAt).toBe(opens + 3_600_000);
    expect(w.secondsUntilOpen).toBe(3600);
  });

  it("is open for exactly sixty minutes", () => {
    expect(computeWindow(opens, tz, "20:00").isOpen).toBe(true);
    expect(computeWindow(opens + 59 * 60_000, tz, "20:00").isOpen).toBe(true);
    expect(computeWindow(opens + 60 * 60_000, tz, "20:00").isOpen).toBe(false);
  });

  it("rolls to tomorrow once today's window has closed", () => {
    const w = computeWindow(opens + 2 * 3_600_000, tz, "20:00");
    expect(w.isOpen).toBe(false);
    expect(w.dayKey).toBe("2026-09-07");
    expect(w.opensAt).toBe(opens + 24 * 3_600_000);
  });

  it("keeps yesterday's window open when it spans local midnight", () => {
    // 23:30 window opened on the 6th; at 00:15 on the 7th it is still open.
    const open2330 = Date.UTC(2026, 8, 6, 21, 30);
    const w = computeWindow(open2330 + 45 * 60_000, tz, "23:30");
    expect(w.isOpen).toBe(true);
    expect(w.dayKey).toBe("2026-09-06");
    expect(w.secondsUntilClose).toBe(15 * 60);
  });

  it("reports the following day's window as next while open", () => {
    const w = computeWindow(opens + 10 * 60_000, tz, "20:00");
    expect(w.nextOpensAt).toBe(opens + 24 * 3_600_000);
  });
});

describe("helpers", () => {
  it("parses HH:MM", () => {
    expect(parseWindowStart("07:05")).toEqual({ hour: 7, minute: 5 });
    expect(parseWindowStart("24:00")).toBeNull();
    expect(parseWindowStart("nope")).toBeNull();
  });
  it("formats countdowns", () => {
    expect(formatCountdown(3661)).toBe("1h 01m 01s");
    expect(formatCountdown(59)).toBe("0m 59s");
  });
});
