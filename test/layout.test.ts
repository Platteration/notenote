import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

/**
 * Layout rules that hold at every screen shape. CSS geometry has no unit test of its own, so
 * these read the stylesheet as rules — each with the @media / @supports chain around it — and
 * pin the decisions that keep the app usable on phones either way round, tablets, desktops and
 * ultrawide screens. What only a browser can show is checked by eye; these catch the regressions.
 */

const CSS = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  prelude: string;
  ancestors: string[];
  declarations: Array<[string, string]>;
}

/** Every rule in the stylesheet, with the at-rule preludes it is nested in. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: Array<{ prelude: string; body: string }> = [];
  let buffer = "";
  for (const ch of css) {
    if (ch === "{") {
      stack.push({ prelude: buffer.trim(), body: "" });
      buffer = "";
    } else if (ch === "}") {
      const frame = stack.pop();
      if (!frame) throw new Error("unbalanced braces");
      const body = frame.body + buffer;
      buffer = "";
      if (!frame.prelude.startsWith("@")) {
        const declarations = body
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d.includes(":"))
          .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as [string, string]);
        out.push({ prelude: frame.prelude, ancestors: stack.map((f) => f.prelude), declarations });
      }
    } else if (stack.length && ch === ";" && !stack[stack.length - 1]!.prelude.startsWith("@")) {
      stack[stack.length - 1]!.body += buffer + ";";
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return out;
}

const RULES = rules(CSS);

/** The top-level rule whose selector list is exactly `selector`. */
function base(selector: string): Rule {
  const found = RULES.find((r) => r.ancestors.length === 0 && r.prelude === selector);
  if (!found) throw new Error(`no top-level rule ${selector}`);
  return found;
}

function value(rule: Rule, property: string): string | undefined {
  return [...rule.declarations].reverse().find(([p]) => p === property)?.[1];
}

/** Split a value on top-level spaces, leaving the insides of parentheses alone. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

const SIDES = ["top", "right", "bottom", "left"] as const;
/** Which sides each slot of a 1-, 2-, 3- or 4-value box shorthand sets. */
const SLOTS: Record<number, string[][]> = {
  1: [["top", "right", "bottom", "left"]],
  2: [["top", "bottom"], ["right", "left"]],
  3: [["top"], ["right", "left"], ["bottom"]],
  4: [["top"], ["right"], ["bottom"], ["left"]],
};

describe("safe areas", () => {
  it("put every inset on the side it names", () => {
    const checked: string[] = [];
    for (const rule of RULES) {
      for (const [property, text] of rule.declarations) {
        if (!text.includes("env(safe-area-inset-")) continue;
        const where = `${rule.prelude} { ${property} }`;
        const side = SIDES.find((s) => property === s || property.endsWith(`-${s}`));
        if (side) {
          for (const other of SIDES.filter((s) => s !== side)) expect(text, where).not.toContain(`safe-area-inset-${other}`);
        } else if (property === "padding" || property === "margin" || property === "inset") {
          const parts = tokens(text);
          const slots = SLOTS[parts.length];
          expect(slots, where).toBeDefined();
          parts.forEach((part, i) => {
            for (const s of SIDES) if (part.includes(`safe-area-inset-${s}`)) expect(slots![i], `${where}: ${s} in slot ${i + 1}`).toContain(s);
          });
        } else continue; // max-width and the like may subtract both sides.
        checked.push(where);
      }
    }
    expect(checked.length).toBeGreaterThan(8);
  });

  it("keep the scroll header below the status bar and every page clear on all four sides", () => {
    expect(tokens(value(base(".scroll-top"), "padding") ?? "")[0]).toContain("safe-area-inset-top");
    const shell = value(base(".shell"), "padding") ?? "";
    for (const s of SIDES) expect(shell).toContain(`safe-area-inset-${s}`);
    for (const selector of [".slide-body", ".closing"]) {
      const padding = value(base(selector), "padding") ?? "";
      expect(padding, selector).toContain("safe-area-inset-left");
      expect(padding, selector).toContain("safe-area-inset-right");
    }
  });
});

describe("viewport units", () => {
  it("give every dvh length a vh fallback, and keep dvh custom properties behind a dvh check", () => {
    for (const rule of RULES) {
      rule.declarations.forEach(([property, text], i) => {
        if (!text.includes("dvh")) return;
        if (property.startsWith("--")) {
          // A custom property keeps whatever it is given, so a vh twin before it would be dead.
          expect(rule.ancestors.some((a) => /^@supports\s*\(height:\s*1dvh\)/.test(a)), `${rule.prelude} ${property}`).toBe(true);
        } else {
          const earlier = rule.declarations.slice(0, i);
          expect(earlier, `${rule.prelude} ${property}`).toContainEqual([property, text.replaceAll("dvh", "vh")]);
        }
      });
    }
  });

  it("make a slide exactly as tall as the scroller it snaps in", () => {
    expect(value(base(".slide"), "height")).toBe("100%");
    expect(base(".slide").declarations.some(([, text]) => text.includes("dvh"))).toBe(false);
  });
});

describe("touch screens", () => {
  it("apply hover styles only where a pointer can hover", () => {
    const hovers = RULES.filter((r) => r.prelude.includes(":hover"));
    expect(hovers.length).toBeGreaterThan(0);
    for (const rule of hovers) {
      expect(rule.ancestors.some((a) => /^@media[^{]*\(hover:\s*hover\)/.test(a)), rule.prelude).toBe(true);
    }
  });
});

describe("overflow", () => {
  it("never lets the locked screen's glow widen the page", () => {
    expect(value(base(".shell"), "overflow-x")).toBe("clip");
  });

  it("lets the closing ritual scroll instead of clipping both ends", () => {
    const closing = base(".closing");
    expect(value(closing, "overflow-y")).toBe("auto");
    expect(value(closing, "place-items")).toBeUndefined();
    expect(value(base(".closing-inner"), "margin")).toBe("auto");
  });

  it("keeps a wrapped segmented control a rounded rectangle, not a two-line stadium", () => {
    expect(value(base(".segmented"), "border-radius")).toBe("22px");
  });
});

describe("posters of every shape", () => {
  it("letterboxes posters that are not tall over a blurred copy, instead of cropping them", () => {
    const letterbox = RULES.find((r) => r.prelude.includes('[data-poster="wide"]') && r.prelude.includes('[data-poster="square"]'));
    expect(letterbox && value(letterbox, "object-fit")).toBe("contain");
    const backdrop = base(".slide-backdrop");
    expect(value(backdrop, "object-fit")).toBe("cover");
    expect(value(backdrop, "filter")).toMatch(/blur\(/);
  });

  it("measures each poster and marks its slide", () => {
    const source = readFileSync("src/components/ScrollView.tsx", "utf8");
    expect(source).toMatch(/import \{[^}]*posterShape[^}]*\} from "@\/lib\/scroll-ui"/);
    for (const wiring of ["data-poster={shape}", 'className="slide-backdrop"', "onLoadedMetadata=", "naturalWidth", "readyState"]) {
      expect(source, wiring).toContain(wiring);
    }
  });
});

describe("screen shapes", () => {
  const LANDSCAPE = "@media (max-height: 500px) and (orientation: landscape)";
  const STAGE = "@media (min-width: 600px) and (min-height: 501px) and (min-aspect-ratio: 2/3)";
  const within = (media: string, selector: string) => RULES.find((r) => r.ancestors.includes(media) && r.prelude === selector);

  it("gives a phone on its side a text column that scrolls and a clip that is never cropped", () => {
    expect(within(LANDSCAPE, ".slide-body") && value(within(LANDSCAPE, ".slide-body")!, "overflow-y")).toBe("auto");
    expect(within(LANDSCAPE, ".slide-media img, .slide-media video") && value(within(LANDSCAPE, ".slide-media img, .slide-media video")!, "object-fit")).toBe("contain");
    expect(within(LANDSCAPE, ".locked .ring")).toBeDefined();
  });

  it("centres a 9:16 stage on wide screens, with arrows beside it and none on phones", () => {
    expect(value(base(".stage-nav"), "display")).toBe("none");
    const shell = within(STAGE, ".scroll-shell");
    expect(shell && value(shell, "--stage")).toMatch(/9 \/ 16/);
    expect(within(STAGE, ".stage-nav") && value(within(STAGE, ".stage-nav")!, "display")).toBe("flex");
    expect(within(STAGE, ".slide-body") && value(within(STAGE, ".slide-body")!, "width")).toBe("var(--stage)");
  });

  it("sizes the inner pages' headings from the stylesheet, so the landscape rule can reach them", () => {
    for (const page of ["src/app/connect/page.tsx", "src/app/saved/page.tsx", "src/app/settings/page.tsx"]) {
      const source = readFileSync(page, "utf8");
      expect(source, page).toContain('className="hero hero-page"');
      expect(source, page).not.toMatch(/fontSize|paddingTop/);
    }
  });

  it("lets the installed app rotate", () => {
    expect(manifest().orientation).toBeUndefined();
  });
});
