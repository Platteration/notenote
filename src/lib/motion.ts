/**
 * Reduce-motion identity, kept apart from settings.ts for the reason theme.ts is: client
 * components read the option list, and settings.ts pulls the database layer in with it.
 *
 * Three states rather than a switch. `on` and `off` mean exactly that; `system` defers to the
 * device's own reduce-motion setting (`prefers-reduced-motion` on the web), which is the only
 * way to honour it without also being unable to override it.
 */
export type ReduceMotion = "system" | "on" | "off";

/**
 * Typed as a record over the union, so a member dropped here fails the type check rather than
 * quietly turning a user's stored value into the default.
 */
export const REDUCE_MOTION: Record<ReduceMotion, true> = { system: true, on: true, off: true };

export const REDUCE_MOTION_OPTIONS: ReduceMotion[] = ["system", "on", "off"];

export const REDUCE_MOTION_LABELS: Record<ReduceMotion, string> = {
  system: "System",
  on: "On",
  off: "Off",
};

export const REDUCE_MOTION_NOTES: Record<ReduceMotion, string> = {
  system: "Follows your device's reduce-motion setting.",
  on: "Gradient shifts, smooth scrolling and transitions are off, whatever the device says.",
  off: "Full motion, even when the device asks for less.",
};

/**
 * An own-property lookup, never `in` or a bare index: `"constructor" in REDUCE_MOTION` is true,
 * and a stored value is whatever the row holds.
 */
export function isReduceMotion(value: unknown): value is ReduceMotion {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REDUCE_MOTION, value);
}

/**
 * What a stored value means, including the boolean that builds before the three-state setting
 * wrote. `true` was a choice, so it becomes `on`. `false` was the default nobody chose, so it
 * becomes `system` rather than `off`: `off` would override a device preference the user never
 * asked to override.
 */
export function migrateReduceMotion(value: unknown, fallback: ReduceMotion): ReduceMotion {
  if (value === true) return "on";
  if (value === false) return "system";
  return isReduceMotion(value) ? value : fallback;
}

/** `on` and `off` are literal; `system` is whatever the platform says. Nothing is ORed. */
export function resolveReduceMotion(setting: ReduceMotion, systemPrefers: boolean): boolean {
  if (setting === "system") return systemPrefers;
  return setting === "on";
}

/**
 * The root attribute the stylesheet reads: "true" reduces, "false" keeps full motion whatever
 * the device says, and no attribute at all leaves it to `prefers-reduced-motion`.
 */
export function reduceMotionAttribute(setting: ReduceMotion): "true" | "false" | undefined {
  if (setting === "system") return undefined;
  return setting === "on" ? "true" : "false";
}
