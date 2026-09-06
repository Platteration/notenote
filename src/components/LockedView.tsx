"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Countdown } from "./Countdown";
import type { LockedPayload } from "@/lib/feed";

function formatLocal(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function LockedView({ initial }: { initial: LockedPayload }) {
  const router = useRouter();
  const [state] = useState(initial);
  const win = state.window;
  const onZero = useCallback(() => router.refresh(), [router]);

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

  return (
    <section className="locked">
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
