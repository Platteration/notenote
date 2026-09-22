import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prefs } from "@/lib/settings";
import { haptic, scrollBehavior } from "@/lib/effects";

const prefs = (over: Partial<Prefs>): Prefs => ({ theme: "system", reduceMotion: "system", haptics: true, sound: false, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The rows are independent: a haptic fires iff the Haptics row is on, and Reduce motion governs
 * decorative motion only. An earlier build also silenced haptics under reduce motion, so a user
 * who wanted taps but no transitions could not have them.
 */
describe("haptics", () => {
  it("fire when the Haptics row is on, whatever Reduce motion says", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });
    haptic(prefs({ haptics: true, reduceMotion: "on" }), 12);
    expect(vibrate).toHaveBeenCalledWith(12);
    haptic(prefs({ haptics: true, reduceMotion: "off" }), [30, 40, 30]);
    haptic(prefs({ haptics: true, reduceMotion: "system" }), 8);
    expect(vibrate).toHaveBeenCalledTimes(3);
  });

  it("do not fire when the Haptics row is off, whatever Reduce motion says", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });
    for (const reduceMotion of ["system", "on", "off"] as const) haptic(prefs({ haptics: false, reduceMotion }), 12);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("degrade silently where the browser has no vibration", () => {
    vi.stubGlobal("navigator", {});
    expect(() => haptic(prefs({ haptics: true }), 12)).not.toThrow();
  });
});

describe("scroll behaviour", () => {
  it("is decided by reduce motion alone: on and off literally, system by the device", () => {
    // No matchMedia here, which means the device has stated no preference.
    expect(scrollBehavior(prefs({ reduceMotion: "on" }))).toBe("auto");
    expect(scrollBehavior(prefs({ reduceMotion: "off" }))).toBe("smooth");
    expect(scrollBehavior(prefs({ reduceMotion: "system" }))).toBe("smooth");
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(scrollBehavior(prefs({ reduceMotion: "system" }))).toBe("auto");
    expect(scrollBehavior(prefs({ reduceMotion: "off" }))).toBe("smooth");
  });
});
