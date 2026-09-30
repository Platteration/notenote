import { describe, expect, it } from "vitest";
import { ACCENT_CATALOGUE, ACCENTS, DEFAULT_ACCENT, isAccent } from "@/lib/accent";

describe("the accent catalogue", () => {
  it("offers exactly these accents, in this order", () => {
    expect(ACCENTS).toEqual(["apricot", "ember", "gold", "lime", "mint", "sky", "violet", "rose"]);
    expect(ACCENTS).toEqual(ACCENT_CATALOGUE.map((a) => a.id));
  });

  it("has unique ids and a label for each", () => {
    expect(new Set(ACCENTS).size).toBe(ACCENTS.length);
    for (const a of ACCENT_CATALOGUE) expect(a.label).toBeTruthy();
  });

  it("defaults to the pair the themes already carry", () => {
    expect(DEFAULT_ACCENT).toBe("apricot");
    expect(ACCENTS).toContain(DEFAULT_ACCENT);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isAccent("sky")).toBe(true);
    expect(isAccent("neon")).toBe(false);
    expect(isAccent(null)).toBe(false);
  });

  it("stays a leaf module, so client components can import it without pulling in the database", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/accent.ts", "utf8");
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });
});
