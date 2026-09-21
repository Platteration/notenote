import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-settings-contract-tests";

const { getDb } = await import("@/lib/db");
const { REDUCE_MOTION, REDUCE_MOTION_LABELS, REDUCE_MOTION_NOTES, REDUCE_MOTION_OPTIONS } = await import("@/lib/motion");
const { DEFAULT_PREFS } = await import("@/lib/settings");
const { THEMES } = await import("@/lib/theme");

/**
 * The settings contract, pinned as literals. A renamed field or a dropped enum member here
 * changes what every stored row means, so the test says what the app promises rather than
 * deriving it from the code under test.
 */
describe("the settings contract", () => {
  it("stores preferences in one place: the prefs column of the settings row, keyed by user", () => {
    // No client-side store: the server applies preferences before the page is drawn.
    const columns = (getDb().prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(["user_id", "timezone", "window_start", "feed_size", "updated_at", "prefs"]);
    for (const file of ["src/components/SettingsForm.tsx", "src/lib/settings.ts", "src/lib/effects.ts"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/localStorage|sessionStorage/);
    }
  });

  it("offers exactly these rows", () => {
    expect(Object.keys(DEFAULT_PREFS)).toEqual(["theme", "reduceMotion", "haptics", "sound"]);
    expect(DEFAULT_PREFS).toEqual({ theme: "system", reduceMotion: "system", haptics: true, sound: false });
  });

  it("offers exactly these themes", () => {
    expect(THEMES).toEqual(["system", "dark", "light", "wire"]);
  });

  it("offers exactly these reduce-motion states, in this order, each labelled and explained", () => {
    expect(REDUCE_MOTION_OPTIONS).toEqual(["system", "on", "off"]);
    expect(Object.keys(REDUCE_MOTION)).toEqual(["system", "on", "off"]);
    expect(Object.keys(REDUCE_MOTION_LABELS)).toEqual(["system", "on", "off"]);
    expect(Object.keys(REDUCE_MOTION_NOTES)).toEqual(["system", "on", "off"]);
  });

  it("keeps the motion module a leaf, like the theme module, so client components can import it", () => {
    const source = readFileSync("src/lib/motion.ts", "utf8");
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });

  it("reads the version the About card shows from package.json, not from npm's environment", async () => {
    const { APP_VERSION } = await import("@/lib/version");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(readFileSync("src/lib/version.ts", "utf8")).not.toMatch(/process\.env/);
  });
});
