"use client";

import { detectPlatform, nativeUrl } from "./providers/meta";
import type { MediaItem } from "./providers/types";

/**
 * Open a clip in the platform's native app when possible.
 *
 * On phones we first try the app's URL scheme; if nothing captures the navigation within
 * a moment (the app isn't installed) we fall back to the https permalink, which the OS
 * still routes to the app through universal/app links when it can. On desktop the
 * permalink opens in a new tab.
 */
export function openInNativeApp(item: MediaItem): void {
  if (typeof window === "undefined") return;
  const platform = detectPlatform(navigator.userAgent);
  const scheme = platform === "other" ? null : nativeUrl(item, platform);

  if (!scheme) {
    window.open(item.permalink, "_blank", "noopener,noreferrer");
    return;
  }

  const started = Date.now();
  let settled = false;
  const cleanup = () => {
    settled = true;
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("blur", onHide);
  };
  const onHide = () => cleanup();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("blur", onHide);

  window.location.href = scheme;

  window.setTimeout(() => {
    if (settled || document.hidden) return cleanup();
    // The scheme fired but nothing took the hand-off within the grace period: no app installed.
    if (Date.now() - started < 2500) window.location.href = item.permalink;
    cleanup();
  }, 1400);
}
