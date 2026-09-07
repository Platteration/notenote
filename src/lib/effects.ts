"use client";

import type { Prefs } from "./settings";

/**
 * Small sensory touches. Everything here is opt-out (haptics) or opt-in (sound), degrades
 * silently where the browser doesn't support it, and never blocks the UI.
 */

export function haptic(prefs: Pick<Prefs, "haptics" | "reduceMotion">, pattern: number | number[]): void {
  if (!prefs.haptics || prefs.reduceMotion) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* some browsers throw when the page isn't focused */
  }
}

type AudioContextCtor = typeof AudioContext;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * A two-note tone generated on the fly, so there are no audio assets to ship.
 * "open" rises, "close" falls.
 */
export function chime(prefs: Pick<Prefs, "sound">, kind: "open" | "close"): void {
  if (!prefs.sound) return;
  const ctx = audioContext();
  if (!ctx) return;
  const notes = kind === "open" ? [587.33, 880.0] : [587.33, 392.0];
  const start = ctx.currentTime + 0.02;
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = start + i * 0.16;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.14, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
  window.setTimeout(() => void ctx.close().catch(() => {}), 1400);
}

/** Whether the viewer has asked their OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function scrollBehavior(prefs: Pick<Prefs, "reduceMotion">): ScrollBehavior {
  return prefs.reduceMotion || prefersReducedMotion() ? "auto" : "smooth";
}
