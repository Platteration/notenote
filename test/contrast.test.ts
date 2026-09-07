import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Colour contrast is easy to regress by nudging one token, and a person notices only once
 * the text is already hard to read. These checks compute the real WCAG ratios from the
 * stylesheet, so a future palette change has to stay legible to land.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");

const AA_NORMAL = 4.5;

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
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Flatten a translucent colour onto an opaque one, as the browser does. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;
}

/** Pull the custom properties out of one rule block. */
function tokensOf(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  const body = CSS.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const THEMES = [
  { name: "dark", selector: ":root {" },
  { name: "light", selector: ':root[data-theme="light"] {' },
  { name: "wire", selector: ':root[data-theme="wire"] {' },
];

// Badge backgrounds as declared in the stylesheet, over the card surface.
const BADGES: Array<{ ink: string; tint: Rgb; alpha: number }> = [
  { ink: "--badge-demo-ink", tint: [255, 179, 71], alpha: 0.15 },
  { ink: "--badge-live-ink", tint: [57, 217, 138], alpha: 0.15 },
  { ink: "--badge-off-ink", tint: [128, 128, 150], alpha: 0.12 },
];

describe.each(THEMES)("$name theme contrast", ({ name, selector }) => {
  const tokens = tokensOf(selector);
  // The wireframe theme draws cards as outlines, so text sits on the page itself.
  const surface = parseHex(tokens["--bg-elev"]?.startsWith("#") ? tokens["--bg-elev"] : tokens["--bg"]);
  const page = parseHex(tokens["--bg"]);

  it("defines every colour token the themes share", () => {
    for (const token of ["--bg", "--fg", "--fg-muted", "--fg-faint", ...BADGES.map((b) => b.ink)]) {
      expect(tokens[token], `${name} is missing ${token}`).toBeTruthy();
    }
  });

  it.each(["--fg", "--fg-muted", "--fg-faint"])("%s clears WCAG AA on both surfaces", (token) => {
    const ink = parseHex(tokens[token]);
    expect(contrast(ink, surface), `${name} ${token} on the card surface`).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(ink, page), `${name} ${token} on the page`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(BADGES)("$ink clears WCAG AA on its own tinted pill", ({ ink, tint, alpha }) => {
    // Badge pills are translucent in dark and light; the wireframe theme leaves them clear.
    const pill = name === "wire" ? surface : composite(tint, alpha, surface);
    expect(contrast(parseHex(tokens[ink]), pill), `${name} ${ink}`).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
