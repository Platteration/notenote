import { describe, expect, it } from "vitest";
import { isTheme, THEME_LABELS, THEME_NOTES, THEMES } from "@/lib/theme";

describe("themes", () => {
  it("offers system, dark, light and wire", () => {
    expect(THEMES).toEqual(["system", "dark", "light", "wire"]);
  });

  it("labels and describes every theme", () => {
    for (const theme of THEMES) {
      expect(THEME_LABELS[theme]).toBeTruthy();
      expect(THEME_NOTES[theme].length).toBeGreaterThan(10);
    }
  });

  it("guards against unknown values", () => {
    expect(isTheme("wire")).toBe(true);
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
