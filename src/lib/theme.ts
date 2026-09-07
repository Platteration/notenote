/**
 * Theme identity, kept apart from settings.ts so client components can import the list
 * without pulling the database layer (and node:sqlite) into the browser bundle.
 */
export type Theme = "system" | "dark" | "light" | "wire";

export const THEMES: Theme[] = ["system", "dark", "light", "wire"];

export const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
  wire: "Wire",
};

export const THEME_NOTES: Record<Theme, string> = {
  system: "Follows your device between light and dark.",
  dark: "Dark surfaces, full-colour platform marks.",
  light: "Warm paper tones for daylight.",
  wire: "Black ground and white line work. Surfaces are drawn as outlines, and each platform keeps a tint so you can still tell them apart.",
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}
