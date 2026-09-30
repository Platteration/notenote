/**
 * Accent identity, kept apart from settings.ts for the same reason as theme.ts: client
 * components read this list, and it must not pull the database layer into the browser bundle.
 *
 * An accent is five token blocks in globals.css — a base dark block `[data-accent="<id>"]`,
 * the OS-light copy inside the `prefers-color-scheme: light` media query, and one block each
 * for the pinned light, dusk and wire themes — plus one entry in the catalogue below. No colour
 * lives here: the stylesheet is the source of truth, and test/contrast.test.ts iterates this
 * catalogue against every scheme, so a missing or illegible block fails the suite.
 */
export type Accent = "apricot" | "ember" | "gold" | "lime" | "mint" | "sky" | "violet" | "rose";

export interface AccentMeta {
  id: Accent;
  label: string;
}

export const ACCENT_CATALOGUE: AccentMeta[] = [
  { id: "apricot", label: "Apricot" },
  { id: "ember", label: "Ember" },
  { id: "gold", label: "Gold" },
  { id: "lime", label: "Lime" },
  { id: "mint", label: "Mint" },
  { id: "sky", label: "Sky" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
];

export const ACCENTS: Accent[] = ACCENT_CATALOGUE.map((a) => a.id);

/** The pair the themes carry themselves; `<html>` gets no data-accent attribute for it. */
export const DEFAULT_ACCENT: Accent = "apricot";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as string[]).includes(value);
}
