"use client";

import { useEffect, useState } from "react";
import { readSiteConfig, SITE_OFF, withoutParam, type SiteConfig } from "./site-config";

let asked: Promise<SiteConfig> | null = null;

/**
 * `GET /api/config`, asked once per page load and shared by every component that wants it. A
 * failure of any kind is "nothing configured", kept for the life of the page: nothing is asked
 * again.
 */
export function loadSiteConfig(): Promise<SiteConfig> {
  asked ??= fetch("/api/config", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) })
    .then(async (response) => readSiteConfig(response.status, await response.text()))
    .catch(() => SITE_OFF);
  return asked;
}

/** The site's configuration once it is known; null until then, so nothing is drawn early. */
export function useSiteConfig(): SiteConfig | null {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  useEffect(() => {
    let live = true;
    void loadSiteConfig().then((value) => {
      if (live) setConfig(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/**
 * Take a query parameter (`?signin=`, `?link=`, `?purchase=`) out of the address once the page
 * has read it, so a reload does not say it again.
 *
 * Through `history.replaceState(null, …)`, which the app router patches so that it learns the
 * new address: unpatched, the router keeps the old one, and its next refresh (the one that
 * draws the supporter badge, say) writes it back. The router patches history in an effect of its
 * own, which runs after the effects of the page inside it, so the call waits for the next task.
 */
export function useForgetParam(name: string, when: boolean): void {
  useEffect(() => {
    if (!when) return;
    const timer = setTimeout(() => window.history.replaceState(null, "", withoutParam(window.location.href, name)), 0);
    return () => clearTimeout(timer);
  }, [name, when]);
}
