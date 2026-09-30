/**
 * Theme identity, kept apart from settings.ts so client components can import the list
 * without pulling the database layer (and node:sqlite) into the browser bundle.
 *
 * A theme is a token block in globals.css — `:root[data-theme="<id>"]`, or the bare `:root`
 * defaults in the case of "dark" — plus one entry in the catalogue below. "system" is the
 * absence of the attribute and has no block of its own. The contrast test iterates this
 * catalogue, so a new entry is checked for legibility the moment its block exists.
 */
export type Theme = "system" | "dark" | "light" | "wire" | "dusk";

export type ThemeKind = "core" | "seasonal";
export type ThemeTier = "free" | "supporter";

export interface ThemeMeta {
  id: Theme;
  label: string;
  note: string;
  /** Core themes are always offered; seasonal ones arrive over time. */
  kind: ThemeKind;
  /** Seasonal only, e.g. "Autumn 2026". */
  season?: string;
  /** Seasonal only: ISO date of release. */
  releasedAt?: string;
  /**
   * Everything is free today. The field exists so a future supporter tier could gate a
   * theme without a schema change — not because anything is gated now.
   */
  tier: ThemeTier;
  /** Wire draws badges as outlines on the bare surface; every other theme uses tinted pills. */
  badges: "pill" | "outline";
}

export const THEME_CATALOGUE: ThemeMeta[] = [
  {
    id: "system",
    label: "System",
    note: "Follows your device between light and dark.",
    kind: "core",
    tier: "free",
    badges: "pill",
  },
  {
    id: "dark",
    label: "Dark",
    note: "Dark surfaces, full-colour platform marks.",
    kind: "core",
    tier: "free",
    badges: "pill",
  },
  {
    id: "light",
    label: "Light",
    note: "Warm paper tones for daylight.",
    kind: "core",
    tier: "free",
    badges: "pill",
  },
  {
    id: "wire",
    label: "Wire",
    note: "Black ground and white line work. Surfaces are drawn as outlines, and each platform keeps a tint so you can still tell them apart.",
    kind: "core",
    tier: "free",
    badges: "outline",
  },
  {
    id: "dusk",
    label: "Dusk",
    note: "Deep indigo with apricot accents. An evening mood, for an hour that opens at night.",
    kind: "seasonal",
    season: "Autumn 2026",
    releasedAt: "2026-09-30",
    tier: "free",
    badges: "pill",
  },
];

export const THEMES: Theme[] = THEME_CATALOGUE.map((t) => t.id);

export const THEME_LABELS = Object.fromEntries(THEME_CATALOGUE.map((t) => [t.id, t.label])) as Record<Theme, string>;

export const THEME_NOTES = Object.fromEntries(THEME_CATALOGUE.map((t) => [t.id, t.note])) as Record<Theme, string>;

export function themeMeta(id: Theme): ThemeMeta {
  // Every id in the union has an entry, so the lookup cannot miss.
  return THEME_CATALOGUE.find((t) => t.id === id)!;
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}
