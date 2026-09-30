import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { posterShape, scrollKeyAction } from "@/lib/scroll-ui";

describe("poster shapes", () => {
  it("classifies the shapes the platforms hand back", () => {
    expect(posterShape(540, 960)).toBe("tall"); // the demo catalogue, TikTok
    expect(posterShape(1080, 1620)).toBe("tall"); // 2:3
    expect(posterShape(1080, 1080)).toBe("square");
    expect(posterShape(1080, 1350)).toBe("square"); // 4:5
    expect(posterShape(1280, 720)).toBe("wide"); // YouTube, Twitch
    expect(posterShape(640, 480)).toBe("wide"); // 4:3
  });

  it("draws the lines exactly where it says", () => {
    expect(posterShape(699, 1000)).toBe("tall");
    expect(posterShape(700, 1000)).toBe("square");
    expect(posterShape(1250, 1000)).toBe("square");
    expect(posterShape(1251, 1000)).toBe("wide");
  });

  it("has no opinion about a poster it could not measure", () => {
    expect(posterShape(0, 0)).toBeUndefined();
    expect(posterShape(100, 0)).toBeUndefined();
    expect(posterShape(Number.NaN, 10)).toBeUndefined();
  });
});

/** A stand-in for event.target: `closest` matches when any listed selector is one it "is". */
function el(kinds: string[]) {
  return { closest: (selectors: string) => (selectors.split(",").some((s) => kinds.includes(s.trim())) ? {} : null) };
}
const press = (key: string, target: ReturnType<typeof el> | null = null, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  scrollKeyAction({ key, altKey: false, ctrlKey: false, metaKey: false, target, ...mods });

describe("keys in the scroll", () => {
  it("moves and opens from the page itself", () => {
    for (const key of ["ArrowDown", "j", " "]) expect(press(key)).toBe("next");
    for (const key of ["ArrowUp", "k"]) expect(press(key)).toBe("prev");
    for (const key of ["Enter", "o"]) expect(press(key)).toBe("open");
    expect(press("x")).toBeNull();
  });

  it("leaves shortcuts with modifiers to the browser", () => {
    expect(press("ArrowDown", null, { ctrlKey: true })).toBeNull();
    expect(press("j", null, { metaKey: true })).toBeNull();
    expect(press("k", null, { altKey: true })).toBeNull();
  });

  it("gives a text field every key", () => {
    for (const kind of ["input", "textarea", "select", "[contenteditable=true]"]) {
      for (const key of ["ArrowDown", "j", "k", " ", "Enter", "o"]) expect(press(key, el([kind])), `${kind} ${key}`).toBeNull();
    }
  });

  it("keeps moving after a button or link was clicked, and lets Enter and Space press it", () => {
    for (const kind of ["button", "a"]) {
      expect(press("ArrowDown", el([kind]))).toBe("next");
      expect(press("k", el([kind]))).toBe("prev");
      expect(press("o", el([kind]))).toBe("open");
      expect(press("Enter", el([kind]))).toBeNull();
      expect(press(" ", el([kind]))).toBeNull();
    }
  });

  it("stays a leaf module, so the client component can import it", () => {
    const source = readFileSync("src/lib/scroll-ui.ts", "utf8");
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });
});
