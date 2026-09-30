import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENT_CATALOGUE, DEFAULT_ACCENT } from "@/lib/accent";
import { THEME_CATALOGUE } from "@/lib/theme";

/**
 * Colour contrast is easy to regress by nudging one token, and a person notices only once
 * the text is already hard to read. These checks compute the real WCAG ratios from the
 * stylesheet, so a future palette change has to stay legible to land.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");

const AA_NORMAL = 4.5;
/** Large text and non-text contrast (WCAG 1.4.3 / 1.4.11). */
const AA_LARGE = 3;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Flatten a translucent colour onto an opaque one, as the browser does. */
function composite([fr, fg, fb]: Rgb, alpha: number, [br, bg, bb]: Rgb): Rgb {
  const over = (top: number, under: number) => Math.round(top * alpha + under * (1 - alpha));
  return [over(fr, br), over(fg, bg), over(fb, bb)];
}

/**
 * Pull the custom properties out of one rule block. The selector must open a rule at the
 * start of a line, alone or first in a selector list, so `[data-accent="x"]` can never be read
 * as a theme block and `:root` cannot match `:root[data-reduce-motion]`. The match is
 * returned too, so a caller can check what else the selector list contained.
 */
function ruleFor(selector: string): { tokens: Record<string, string>; prelude: string } {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*${esc}\\s*(?:,[^{}]*)?\\{`, "m").exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  const open = match.index + match[0].length;
  const close = CSS.indexOf("}", open);
  const body = CSS.slice(open, close);
  const tokens: Record<string, string> = {};
  // Neither group is optional, so every match carries both.
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[name!] = value!.trim();
  return { tokens, prelude: match[0] };
}

/** A token a block must define: its absence fails here, naming the block and the token. */
function need(tokens: Record<string, string>, key: string, where: string): string {
  const value = tokens[key];
  if (value === undefined) throw new Error(`${where} is missing ${key}`);
  return value;
}

function tokensOf(selector: string): Record<string, string> {
  return ruleFor(selector).tokens;
}

function pick(tokens: Record<string, string>, names: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const n of names) out[n] = tokens[n];
  return out;
}

/**
 * Every theme in the catalogue is checked, so adding one to theme.ts is enough to bring it
 * under test — and a catalogue entry with no stylesheet block fails loudly in tokensOf.
 * "dark" is the bare :root defaults. "system" has no block of its own: on a dark OS it is the
 * :root defaults, and on a light OS it is the `:root:not([data-theme])` block inside the
 * prefers-color-scheme media query, which is checked here as its own scheme.
 */
const SCHEMES = [
  ...THEME_CATALOGUE.filter((t) => t.id !== "system").map((t) => ({
    name: t.id,
    selector: t.id === "dark" ? ":root" : `:root[data-theme="${t.id}"]`,
    badges: t.badges,
    accentSelector: (id: string) => (t.id === "dark" ? `[data-accent="${id}"]` : `:root[data-theme="${t.id}"][data-accent="${id}"]`),
  })),
  {
    name: "system-light",
    selector: ":root:not([data-theme])",
    badges: "pill" as const,
    accentSelector: (id: string) => `:root:not([data-theme])[data-accent="${id}"]`,
  },
];

// Badge backgrounds as declared in the stylesheet, over the card surface.
const BADGES: Array<{ ink: string; tint: Rgb; alpha: number }> = [
  { ink: "--badge-demo-ink", tint: [255, 179, 71], alpha: 0.15 },
  { ink: "--badge-live-ink", tint: [57, 217, 138], alpha: 0.15 },
  { ink: "--badge-off-ink", tint: [128, 128, 150], alpha: 0.12 },
];

const ACCENT_TOKENS = ["--accent", "--accent-2", "--accent-ink"];
/** The scroll is always black, and the time bar, list markers and reason bars sit on it. */
const SCROLL: Rgb = [0, 0, 0];

describe.each(SCHEMES)("$name theme contrast", ({ name, selector, badges, accentSelector }) => {
  const tokens = tokensOf(selector);
  const required = (key: string): string => need(tokens, key, name);
  // The wireframe theme draws cards as outlines, so text sits on the page itself.
  const elevated = tokens["--bg-elev"];
  const surface = parseHex(elevated?.startsWith("#") ? elevated : required("--bg"));
  const page = parseHex(required("--bg"));
  // Inputs sit on the raised surface; the wire theme leaves them transparent on the page.
  const raised = tokens["--bg-elev-2"];
  const focusSurface = raised?.startsWith("#") ? parseHex(raised) : page;

  it("defines every colour token the themes share", () => {
    for (const token of ["--bg", "--fg", "--fg-muted", "--fg-faint", ...ACCENT_TOKENS, ...BADGES.map((b) => b.ink)]) {
      expect(tokens[token], `${name} is missing ${token}`).toBeTruthy();
    }
  });

  it.each(["--fg", "--fg-muted", "--fg-faint"])("%s clears WCAG AA on both surfaces", (token) => {
    const ink = parseHex(required(token));
    expect(contrast(ink, surface), `${name} ${token} on the card surface`).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(ink, page), `${name} ${token} on the page`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(["--fg", "--fg-muted"])("%s clears WCAG AA on the raised field surface (search, notes, filters)", (token) => {
    // The archive puts text and placeholders on --bg-elev-2; wire's is translucent over the page.
    const raisedValue = required("--bg-elev-2");
    const rgba = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(raisedValue);
    const ground = rgba ? composite([Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], Number(rgba[4]), page) : parseHex(raisedValue);
    expect(contrast(parseHex(required(token)), ground), `${name} ${token} on --bg-elev-2`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(BADGES)("$ink clears WCAG AA on its own tinted pill", ({ ink, tint, alpha }) => {
    // Most themes tint the pill; a theme that draws badges as outlines leaves the surface bare.
    const pill = badges === "outline" ? surface : composite(tint, alpha, surface);
    expect(contrast(parseHex(required(ink)), pill), `${name} ${ink}`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  /**
   * Every accent is checked under every scheme. A missing block throws in ruleFor; a block
   * without the descendant selector (which the picker swatches rely on) fails the first test.
   */
  const accents = ACCENT_CATALOGUE.map((a) => ({ id: a.id, ...ruleFor(accentSelector(a.id)) }));

  it.each(accents)("$id declares its pair for this scheme, for the page and for the swatch preview", ({ id, tokens: t, prelude }) => {
    for (const token of ACCENT_TOKENS) expect(t[token], `${name}/${id} is missing ${token}`).toBeTruthy();
    // The bare base block matches a swatch element itself; every scheme block needs a
    // descendant form (`… [data-accent="x"]`) for the swatch to preview that scheme's pair.
    if (!accentSelector(id).startsWith("[")) {
      expect(prelude, `${name}/${id} needs its descendant selector so the picker swatch previews this scheme's pair`).toMatch(
        new RegExp(`[\\])] \\[data-accent="${id}"\\]`),
      );
    }
  });

  it.each(accents)("$id keeps primary-button ink (and the switch thumb) legible on both ends of the gradient", ({ id, tokens: t }) => {
    const where = `${name}/${id}`;
    const ink = parseHex(need(t, "--accent-ink", where));
    expect(contrast(ink, parseHex(need(t, "--accent", where)))).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(ink, parseHex(need(t, "--accent-2", where)))).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(accents)("$id is a visible focus border on a field", ({ id, tokens: t }) => {
    // The accent border is the only focus indicator on text fields, so it must clear 3:1.
    expect(contrast(parseHex(need(t, "--accent", `${name}/${id}`)), focusSurface)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it.each(accents)("$id pair is visible on the card, the page and the black scroll", ({ id, tokens: t }) => {
    for (const token of ["--accent", "--accent-2"]) {
      const colour = parseHex(need(t, token, `${name}/${id}`));
      expect(contrast(colour, surface), `${token} on the card`).toBeGreaterThanOrEqual(AA_LARGE);
      expect(contrast(colour, page), `${token} on the page`).toBeGreaterThanOrEqual(AA_LARGE);
      expect(contrast(colour, SCROLL), `${token} on the scroll`).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  if (badges === "outline") {
    // Wire uses the accent as button and segmented-control text, not as a fill.
    it.each(accents)("$id is legible as text on the wire ground", ({ id, tokens: t }) => {
      expect(contrast(parseHex(need(t, "--accent", `${name}/${id}`)), page)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("carries the default accent in its own tokens, so the default needs no attribute", () => {
    expect(pick(tokensOf(accentSelector(DEFAULT_ACCENT)), ACCENT_TOKENS)).toEqual(pick(tokens, ACCENT_TOKENS));
  });
});

describe("the stylesheet's structure", () => {
  it("gives System on a light OS exactly the pinned Light palette", () => {
    expect(tokensOf(":root:not([data-theme])")).toEqual(tokensOf(':root[data-theme="light"]'));
    for (const a of ACCENT_CATALOGUE) {
      expect(tokensOf(`:root:not([data-theme])[data-accent="${a.id}"]`), a.id).toEqual(
        tokensOf(`:root[data-theme="light"][data-accent="${a.id}"]`),
      );
    }
  });

  it("keeps the accent blocks after every theme block, so the base accent wins by order", () => {
    expect(CSS.indexOf('[data-accent="')).toBeGreaterThan(CSS.lastIndexOf(':root[data-theme="wire"] {'));
  });

  it("draws the switch thumb and the brand-mark glow from the accent tokens", () => {
    expect(CSS).toMatch(/\.switch\[aria-checked="true"\]::after \{[^}]*background: var\(--accent-ink\)/);
    expect(CSS).toMatch(/\.brand-mark \{[^}]*color-mix\(in srgb, var\(--accent-2\) 35%, transparent\)/);
  });
});

describe("the scroll's own colours, which ignore the theme", () => {
  /** The declarations of the first top-level rule whose selector list includes `needle`. */
  function ruleWith(needle: string, from = 0): { selectors: string; body: string } {
    const at = CSS.indexOf(needle, from);
    if (at === -1) throw new Error(`no rule mentioning ${needle}`);
    const open = CSS.indexOf("{", at);
    const start = Math.max(CSS.lastIndexOf("}", at), CSS.lastIndexOf("*/", at), CSS.lastIndexOf("{", at)) + 1;
    const selectors = CSS.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return { selectors, body: CSS.slice(open + 1, CSS.indexOf("}", open)) };
  }
  const prop = (body: string, name: string) => {
    const m = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
    if (!m) throw new Error(`no ${name}`);
    return m[1]!.trim();
  };

  it("draws every button in the scroll white on black, the end slide and the closing ritual included", () => {
    const { selectors, body } = ruleWith(".end-slide .btn");
    for (const s of [".slide-actions .btn", ".end-slide .btn", ".closing .btn"]) expect(selectors).toContain(s);
    const ink = parseHex(prop(body, "color"));
    const fill = parseHex(prop(body, "background"));
    expect(contrast(ink, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    // Against the surfaces they sit on, read from the stylesheet rather than assumed.
    for (const surface of [".slide {", ".closing {"]) {
      const ground = parseHex(prop(ruleWith(surface).body, "background"));
      expect(contrast(fill, ground), surface).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("keeps white text readable on the landscape text column, even over a white poster", () => {
    const media = CSS.indexOf("@media (max-height: 500px) and (orientation: landscape)");
    expect(media).toBeGreaterThan(-1);
    const shade = prop(ruleWith(".slide-shade", media).body, "background");
    const column = Number(/right:\s*(\d+)%/.exec(ruleWith(".slide-media", media).body)?.[1]);
    const boundary = 100 - column; // where the text column starts, as a percentage of the width
    const stops = [...shade.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)\s*(\d+)?%?/g)].map((m, i, all) => ({
      alpha: Number(m[1]),
      at: m[2] !== undefined ? Number(m[2]) : i === all.length - 1 ? 100 : 0,
    }));
    // The lightest point of the shade inside the column is at its left edge.
    const before = [...stops].reverse().find((s) => s.at <= boundary)!;
    const after = stops.find((s) => s.at >= boundary)!;
    const alpha = after.at === before.at ? after.alpha : before.alpha + ((after.alpha - before.alpha) * (boundary - before.at)) / (after.at - before.at);
    // Worst case: a white poster, which the backdrop's brightness(0.5) takes to mid grey.
    const ground = composite([0, 0, 0], alpha, [128, 128, 128]);
    expect(contrast([255, 255, 255], ground), "the title").toBeGreaterThanOrEqual(AA_NORMAL);
    // The stats line is white at 70%, composited on that same ground.
    expect(contrast(composite([255, 255, 255], 0.7, ground), ground), "the stats line").toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
