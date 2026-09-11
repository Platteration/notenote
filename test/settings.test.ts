import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-settings-tests";

const { signUp } = await import("@/lib/auth");
const { DEFAULT_PREFS, getSettings, saveSettings } = await import("@/lib/settings");
const { THEMES } = await import("@/lib/theme");
const { canonicalTimeZone } = await import("@/lib/window");

let userId: string;

beforeAll(async () => {
  userId = (await signUp({ email: "prefs@example.com", displayName: "Prefs", password: "password123" })).id;
});

describe("preferences", () => {
  it("starts from the defaults", () => {
    expect(getSettings(userId).prefs).toEqual(DEFAULT_PREFS);
  });

  it("saves a partial patch without disturbing the rest", () => {
    saveSettings(userId, { prefs: { theme: "light" } });
    saveSettings(userId, { prefs: { sound: true } });
    const prefs = getSettings(userId).prefs;
    expect(prefs.theme).toBe("light");
    expect(prefs.sound).toBe(true);
    expect(prefs.haptics).toBe(DEFAULT_PREFS.haptics);
  });

  it("keeps the hour settings intact when preferences change", () => {
    saveSettings(userId, { windowStart: "07:30", feedSize: 25 });
    saveSettings(userId, { prefs: { reduceMotion: true } });
    const s = getSettings(userId);
    expect(s.windowStart).toBe("07:30");
    expect(s.feedSize).toBe(25);
    expect(s.prefs.reduceMotion).toBe(true);
  });

  it("accepts every offered theme, including the wireframe one", () => {
    for (const theme of THEMES) {
      saveSettings(userId, { prefs: { theme } });
      expect(getSettings(userId).prefs.theme).toBe(theme);
    }
    expect(THEMES).toContain("wire");
  });

  it("rejects an unknown theme", () => {
    expect(() => saveSettings(userId, { prefs: { theme: "neon" as "dark" } })).toThrow(/theme/i);
  });

  it("still enforces the hour rules", () => {
    expect(() => saveSettings(userId, { windowStart: "25:00" })).toThrow(/HH:MM/);
    expect(() => saveSettings(userId, { feedSize: 500 })).toThrow(/between/);
    expect(() => saveSettings(userId, { timezone: "Mars/Olympus" })).toThrow(/timezone/i);
  });
});

describe("timezone", () => {
  it("is stored in the platform's own spelling, whatever case it arrives in", () => {
    // Intl accepts every case permutation of a zone name, and a stored spelling becomes a
    // formatter held for the life of the process — so the collapsing happens on the way in.
    saveSettings(userId, { timezone: "aMeRiCa/nEw_YoRk" });
    expect(getSettings(userId).timezone).toBe(canonicalTimeZone("America/New_York"));
  });

  it("still refuses something that is not a zone", () => {
    expect(() => saveSettings(userId, { timezone: "Not/A_Zone" })).toThrow(/timezone/i);
  });
});
