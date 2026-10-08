"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    /** Set by `public/guard.js`, which every page loads before the app's own scripts. */
    dailyScrollGuard?: { started(): void };
  }
}

/**
 * Tells the safety net in `public/guard.js` that the app has started.
 *
 * An effect runs only once React has taken the server-drawn page over, which is the moment its
 * buttons begin to work. Before it, a script that failed to load or threw leaves a page that
 * looks ready and is not, and the guard says so; after it, failures are the app's to report.
 */
export function Started() {
  useEffect(() => {
    window.dailyScrollGuard?.started();
  }, []);
  return null;
}
