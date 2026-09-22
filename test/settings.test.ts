import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-settings-tests";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { isReduceMotion, migrateReduceMotion, REDUCE_MOTION_OPTIONS, reduceMotionAttribute, resolveReduceMotion } = await import("@/lib/motion");
const { DEFAULT_PREFS, getSettings, parsePrefs, resetPrefs, saveSettings } = await import("@/lib/settings");
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
    saveSettings(userId, { prefs: { reduceMotion: "on" } });
    const s = getSettings(userId);
    expect(s.windowStart).toBe("07:30");
    expect(s.feedSize).toBe(25);
    expect(s.prefs.reduceMotion).toBe("on");
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

  it("accepts every reduce-motion state and rejects anything else", () => {
    for (const reduceMotion of REDUCE_MOTION_OPTIONS) {
      saveSettings(userId, { prefs: { reduceMotion } });
      expect(getSettings(userId).prefs.reduceMotion).toBe(reduceMotion);
    }
    expect(() => saveSettings(userId, { prefs: { reduceMotion: "sometimes" as "on" } })).toThrow(/reduce motion/i);
    expect(() => saveSettings(userId, { prefs: { reduceMotion: "constructor" as "on" } })).toThrow(/reduce motion/i);
  });

  it("still takes the boolean a tab from the previous build sends, with the meaning it had", () => {
    saveSettings(userId, { prefs: { reduceMotion: true as unknown as "on" } });
    expect(getSettings(userId).prefs.reduceMotion).toBe("on");
    saveSettings(userId, { prefs: { reduceMotion: false as unknown as "on" } });
    expect(getSettings(userId).prefs.reduceMotion).toBe("system");
  });

  it("still enforces the hour rules", () => {
    expect(() => saveSettings(userId, { windowStart: "25:00" })).toThrow(/HH:MM/);
    expect(() => saveSettings(userId, { feedSize: 500 })).toThrow(/between/);
    expect(() => saveSettings(userId, { timezone: "Mars/Olympus" })).toThrow(/timezone/i);
  });
});

/** Put raw JSON in the column, the way an older build or a hand edit would have. */
function storePrefs(raw: string) {
  getDb().prepare("UPDATE settings SET prefs = ? WHERE user_id = ?").run(raw, userId);
}

/**
 * The reduce-motion field was a boolean; it is now `system | on | off`. The migration lives in
 * the reader, so every row is read the same way and nothing is rewritten until the user saves.
 */
describe("reduce motion, read from a row an older build wrote", () => {
  it("turns true into on: that was a choice", () => {
    storePrefs('{"reduceMotion":true}');
    expect(getSettings(userId).prefs.reduceMotion).toBe("on");
  });

  it("turns false into system, not off: false was the default nobody chose", () => {
    // `off` would override a device preference the user never asked to override.
    storePrefs('{"reduceMotion":false}');
    expect(getSettings(userId).prefs.reduceMotion).toBe("system");
  });

  it("reads haptics as off while the row still carries the boolean true", () => {
    // Under the build that wrote a boolean, haptic() returned early on reduce motion: this row
    // felt nothing, whatever its haptics field said. Reading it as off hands that user the
    // quiet they had rather than starting to vibrate their phone on the deploy that separated
    // the two rows.
    storePrefs('{"reduceMotion":true,"haptics":true}');
    expect(getSettings(userId).prefs).toMatchObject({ reduceMotion: "on", haptics: false });
    storePrefs('{"reduceMotion":true}');
    expect(getSettings(userId).prefs.haptics).toBe(false);
  });

  it("leaves haptics alone for every row that was not silenced", () => {
    // `false` left the device to decide and haptics fired; a string is a row written since the
    // rows became independent, and On there is a choice made in the new world.
    storePrefs('{"reduceMotion":false,"haptics":true}');
    expect(getSettings(userId).prefs.haptics).toBe(true);
    storePrefs('{"reduceMotion":"on","haptics":true}');
    expect(getSettings(userId).prefs).toMatchObject({ reduceMotion: "on", haptics: true });
    storePrefs('{"reduceMotion":"on"}');
    expect(getSettings(userId).prefs.haptics).toBe(DEFAULT_PREFS.haptics);
  });

  it("migrates once: the next save makes the value the row's own, and taps can be turned back on", () => {
    storePrefs('{"reduceMotion":true,"haptics":true}');
    saveSettings(userId, { prefs: { haptics: true } });
    expect(getSettings(userId).prefs).toMatchObject({ reduceMotion: "on", haptics: true });
  });

  it("reads the three states as themselves", () => {
    for (const state of REDUCE_MOTION_OPTIONS) {
      storePrefs(JSON.stringify({ reduceMotion: state }));
      expect(getSettings(userId).prefs.reduceMotion).toBe(state);
    }
  });

  it("falls back to the default for a value that is none of those, and only for that field", () => {
    storePrefs('{"reduceMotion":"garbage","theme":"wire","sound":true}');
    const prefs = getSettings(userId).prefs;
    expect(prefs.reduceMotion).toBe(DEFAULT_PREFS.reduceMotion);
    expect(prefs.theme).toBe("wire");
    expect(prefs.sound).toBe(true);
  });

  it("does not take a prototype name for a state", () => {
    // Built with JSON.parse: an object literal with __proto__ sets the prototype instead of a key.
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(isReduceMotion(name)).toBe(false);
      expect(migrateReduceMotion(name, "system")).toBe("system");
      const prefs = parsePrefs(JSON.stringify({ reduceMotion: name, theme: name }));
      expect(prefs.reduceMotion).toBe(DEFAULT_PREFS.reduceMotion);
      expect(prefs.theme).toBe(DEFAULT_PREFS.theme);
    }
  });

  it("round-trips the defaults and every member of every table", () => {
    expect(parsePrefs(JSON.stringify(DEFAULT_PREFS))).toEqual(DEFAULT_PREFS);
    for (const theme of THEMES) expect(parsePrefs(JSON.stringify({ theme })).theme).toBe(theme);
    for (const state of REDUCE_MOTION_OPTIONS) expect(parsePrefs(JSON.stringify({ reduceMotion: state })).reduceMotion).toBe(state);
  });

  it("survives a column that is not an object at all", () => {
    // Each of these is held by a different line: "" by the empty check, "{not json" by the
    // catch around JSON.parse, and the rest — "null" above all, which would throw on the first
    // field read — by the shape guard between them. Delete the guard and "null" throws out of
    // parsePrefs; the catch no longer stands behind it to make its absence look the same.
    for (const raw of ["", "null", "[]", '"on"', "42", "{not json", "{}"]) {
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it("resolves on and off literally, and system from the device", () => {
    expect(resolveReduceMotion("on", false)).toBe(true);
    expect(resolveReduceMotion("off", true)).toBe(false);
    expect(resolveReduceMotion("system", true)).toBe(true);
    expect(resolveReduceMotion("system", false)).toBe(false);
  });

  it("writes the root attribute the stylesheet reads, with Off spelled out", () => {
    // "false" is not decoration: the stylesheet's prefers-reduced-motion block is scoped with
    // :root:not([data-reduce-motion="false"]), so dropping the attribute for Off would hand an
    // Off user their device's preference back — the OR the three-state control removed.
    expect(reduceMotionAttribute("on")).toBe("true");
    expect(reduceMotionAttribute("off")).toBe("false");
    expect(reduceMotionAttribute("system")).toBeUndefined();
  });
});

describe("reset to defaults", () => {
  it("puts the preferences back and leaves the hour where it was", () => {
    saveSettings(userId, { windowStart: "06:15", feedSize: 33, prefs: { theme: "wire", reduceMotion: "off", haptics: false, sound: true } });
    const after = resetPrefs(userId);
    expect(after.prefs).toEqual(DEFAULT_PREFS);
    expect(after.windowStart).toBe("06:15");
    expect(after.feedSize).toBe(33);
    const stored = getSettings(userId);
    expect(stored.prefs).toEqual(DEFAULT_PREFS);
    expect(stored.windowStart).toBe("06:15");
    expect(stored.feedSize).toBe(33);
  });

  it("gives a user with no settings row the defaults too", async () => {
    const fresh = (await signUp({ email: "fresh@example.com", displayName: "Fresh", password: "password123" })).id;
    expect(resetPrefs(fresh).prefs).toEqual(DEFAULT_PREFS);
    expect(getSettings(fresh).prefs).toEqual(DEFAULT_PREFS);
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
