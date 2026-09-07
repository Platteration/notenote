"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Countdown } from "./Countdown";
import { PlatformLogo } from "./PlatformLogo";
import { chime } from "@/lib/effects";
import type { LockedPayload } from "@/lib/feed";
import { providerName } from "@/lib/providers/meta";
import type { Prefs } from "@/lib/settings";

/**
 * The colour behind the countdown, warming from deep night to dawn as the hour nears,
 * so the screen has a mood even when it has no content.
 */
function moodFor(secondsUntilOpen: number): string {
  const hours = Math.max(0, secondsUntilOpen) / 3600;
  const night = [80, 90, 200];
  const dawn = [255, 150, 90];
  const t = Math.max(0, Math.min(1, 1 - hours / 6)); // last six hours warm up
  const mix = night.map((n, i) => Math.round(n + (dawn[i] - n) * t));
  return `rgba(${mix[0]}, ${mix[1]}, ${mix[2]}, ${(0.14 + t * 0.16).toFixed(2)})`;
}

function formatLocal(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function LockedView({ initial, prefs }: { initial: LockedPayload; prefs: Prefs }) {
  const router = useRouter();
  const [state] = useState(initial);
  const win = state.window;
  const onZero = useCallback(() => {
    chime(prefs, "open");
    router.refresh();
  }, [router, prefs]);

  // Progress ring: how far through the wait we are (24h cycle).
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const tick = () => {
      const total = 24 * 3600 * 1000 - 3600 * 1000;
      const remaining = Math.max(0, win.opensAt - Date.now());
      setPct(Math.min(100, Math.max(0, 100 - (remaining / total) * 100)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [win.opensAt]);

  const [mood, setMood] = useState(() => moodFor(win.secondsUntilOpen));
  useEffect(() => {
    const id = setInterval(() => setMood(moodFor((win.opensAt - Date.now()) / 1000)), 60_000);
    return () => clearInterval(id);
  }, [win.opensAt]);

  return (
    <section className="locked" style={{ ["--mood" as string]: mood }}>
      <div className="ring" style={{ ["--pct" as string]: `${pct}%` }}>
        <span aria-hidden>🔒</span>
      </div>
      <p>The scroll opens in</p>
      <div className="clock">
        <Countdown target={win.opensAt} onZero={onZero} />
      </div>
      <p>
        Opens {formatLocal(win.opensAt, win.timezone)}, closes {formatLocal(win.closesAt, win.timezone)} ({win.timezone}).
      </p>
      {(state.streak.current > 0 || state.savedCount > 0) && (
        <div className="streak-row">
          {state.streak.current > 0 && (
            <div className="streak">
              <strong>{state.streak.current}</strong>
              <span>day{state.streak.current === 1 ? "" : "s"} in a row</span>
            </div>
          )}
          {state.streak.longest > state.streak.current && (
            <div className="streak">
              <strong>{state.streak.longest}</strong>
              <span>longest run</span>
            </div>
          )}
          {state.savedCount > 0 && (
            <Link className="streak" href="/saved">
              <strong>{state.savedCount}</strong>
              <span>saved to watch</span>
            </Link>
          )}
        </div>
      )}
      {state.recap && (
        <div className="card recap" style={{ textAlign: "left", marginTop: 24 }}>
          <h2>Your last hour</h2>
          <p>
            You watched {state.recap.watched} of {state.recap.total} clips
            {state.recap.watched === state.recap.total && state.recap.total > 0 ? ". The whole scroll." : "."}
          </p>
          {Object.keys(state.recap.perProvider).length > 0 && (
            <div className="recap-row">
              {Object.entries(state.recap.perProvider)
                .sort((a, b) => b[1] - a[1])
                .map(([provider, count]) => (
                  <span className="recap-chip" key={provider} title={providerName(provider)}>
                    <PlatformLogo provider={provider} size={22} />
                    {count}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
      {state.connectedCount === 0 ? (
        <div className="card" style={{ textAlign: "left", marginTop: 24 }}>
          <h2>Nothing to scroll yet</h2>
          <p>Connect at least one platform before your hour opens, or the feed will be empty.</p>
          <p style={{ marginTop: 12 }}>
            <Link className="btn btn-primary" href="/connect">
              Connect a platform
            </Link>
          </p>
        </div>
      ) : (
        <p className="hint">
          {state.connectedCount} platform{state.connectedCount === 1 ? "" : "s"} connected. Change the time in{" "}
          <Link href="/settings" style={{ textDecoration: "underline" }}>
            settings
          </Link>
          .
        </p>
      )}
    </section>
  );
}
