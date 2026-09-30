"use client";

import { useSyncExternalStore } from "react";
import { resolveReduceMotion, type ReduceMotion } from "./motion";
import type { Prefs } from "./settings";

/**
 * Small sensory touches. Everything here is opt-out (haptics) or opt-in (sound), degrades
 * silently where the browser doesn't support it, and never blocks the UI.
 */

/**
 * A haptic fires iff the Haptics row is on. Reduce motion governs decorative motion only —
 * an earlier build also silenced haptics under it, which made one row answer for two and left
 * no way to have taps without transitions.
 */
export function haptic(prefs: Pick<Prefs, "haptics">, pattern: number | number[]): void {
  if (!prefs.haptics) return;
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

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the viewer has asked their OS to reduce motion. A page without matchMedia has not. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Whether motion is reduced right now: the setting when it is `on` or `off`, the device when it
 * is `system`. Nothing is ORed — `off` is a choice to have motion even where the device asks
 * for less — so every caller reads this rather than the field.
 */
export function reducedMotion(prefs: Pick<Prefs, "reduceMotion">): boolean {
  return resolveReduceMotion(prefs.reduceMotion, prefersReducedMotion());
}

export function scrollBehavior(prefs: Pick<Prefs, "reduceMotion">): ScrollBehavior {
  return reducedMotion(prefs) ? "auto" : "smooth";
}

function subscribeToSystemMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * The resolved preference as React state. While the setting is `system` it follows the media
 * query's `change` event, so a device setting flipped mid-session is reflected without a reload;
 * the server render answers `false`, and hydration takes the browser's answer from there.
 */
export function useReduceMotion(setting: ReduceMotion): boolean {
  const system = useSyncExternalStore(subscribeToSystemMotion, prefersReducedMotion, () => false);
  return resolveReduceMotion(setting, system);
}
