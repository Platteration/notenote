import { describe, expect, it } from "vitest";
import { isTheme, THEME_CATALOGUE, THEME_LABELS, THEME_NOTES, THEMES, themeMeta } from "@/lib/theme";

describe("themes", () => {
  it("offers the four core themes and the first seasonal one", () => {
    expect(THEMES).toEqual(["system", "dark", "light", "wire", "dusk"]);
  });

  it("derives the id list from the catalogue, in catalogue order", () => {
    expect(THEMES).toEqual(THEME_CATALOGUE.map((t) => t.id));
  });

  it("labels and describes every theme", () => {
    for (const theme of THEMES) {
      expect(THEME_LABELS[theme]).toBeTruthy();
      expect(THEME_NOTES[theme].length).toBeGreaterThan(10);
    }
  });

  it("gives every entry a unique id", () => {
    const ids = THEME_CATALOGUE.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a tier and a badge style", () => {
    for (const t of THEME_CATALOGUE) {
      expect(["free", "supporter"]).toContain(t.tier);
      expect(["pill", "outline"]).toContain(t.badges);
    }
  });

  it("dates every seasonal theme", () => {
    const seasonal = THEME_CATALOGUE.filter((t) => t.kind === "seasonal");
    expect(seasonal.length).toBeGreaterThan(0);
    for (const t of seasonal) {
      expect(t.season, `${t.id} needs a season`).toBeTruthy();
      expect(t.releasedAt, `${t.id} needs a release date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves core themes undated", () => {
    for (const t of THEME_CATALOGUE.filter((t) => t.kind === "core")) {
      expect(t.season).toBeUndefined();
      expect(t.releasedAt).toBeUndefined();
    }
  });

  it("ships the first seasonal theme free, as the plan requires", () => {
    expect(themeMeta("dusk")).toMatchObject({ kind: "seasonal", tier: "free", season: "Autumn 2026" });
  });

  it("looks up any theme's metadata", () => {
    expect(themeMeta("wire").badges).toBe("outline");
    expect(themeMeta("dark").badges).toBe("pill");
  });

  it("guards against unknown values", () => {
    expect(isTheme("wire")).toBe(true);
    expect(isTheme("dusk")).toBe(true);
    expect(isTheme("neon")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("stays a leaf module, so client components can import it without pulling in the database", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/theme.ts", "utf8");
    // Comments may mention modules; only real import statements matter.
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });
});
