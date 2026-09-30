/**
 * Pure decisions for the scroll view, kept import-free so the client component can use them
 * and vitest can test them without a DOM.
 */

/**
 * The shape of a poster. Platforms hand back thumbnails of every shape — 9:16 covers from
 * TikTok, 16:9 frames from YouTube and Twitch, squares from Instagram — and the slide only
 * crops the tall ones; anything else is letterboxed over a blurred copy of itself.
 */
export type PosterShape = "tall" | "square" | "wide";

export function posterShape(width: number, height: number): PosterShape | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  const ratio = width / height;
  if (ratio < 0.7) return "tall";
  if (ratio > 1.25) return "wide";
  return "square";
}

export type ScrollKeyAction = "next" | "prev" | "open";

interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: { closest(selectors: string): unknown } | null;
}

/**
 * What a key press means in the scroll.
 *
 * A text field keeps every key. A focused button or link keeps Enter and Space, which press
 * it; everything else still moves between clips, so clicking Save does not strand the
 * keyboard on that slide.
 */
export function scrollKeyAction(e: KeyLike): ScrollKeyAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.target?.closest("input, textarea, select, [contenteditable=true]")) return null;
  if (e.target?.closest("button, a") && (e.key === "Enter" || e.key === " ")) return null;
  if (e.key === "ArrowDown" || e.key === "j" || e.key === " ") return "next";
  if (e.key === "ArrowUp" || e.key === "k") return "prev";
  if (e.key === "Enter" || e.key === "o") return "open";
  return null;
}
