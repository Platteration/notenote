"use client";

import { useMemo, useState } from "react";
import { Countdown } from "./Countdown";
import type { Settings } from "@/lib/settings";
import type { DailyWindow } from "@/lib/window";

export function SettingsForm({
  initial,
  initialWindow,
  min,
  max,
}: {
  initial: Settings;
  initialWindow: DailyWindow;
  min: number;
  max: number;
}) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [windowStart, setWindowStart] = useState(initial.windowStart);
  const [feedSize, setFeedSize] = useState(initial.feedSize);
  const [win, setWin] = useState(initialWindow);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone, windowStart, feedSize }),
    });
    const body = (await res.json()) as { error?: string; window?: DailyWindow };
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: body.error ?? "Could not save" });
      return;
    }
    if (body.window) setWin(body.window);
    setMsg({ kind: "ok", text: "Saved." });
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="field">
        <label htmlFor="windowStart">Daily scroll opens at</label>
        <input id="windowStart" type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
        <span className="hint">It closes exactly sixty minutes later.</span>
      </div>
      <div className="field">
        <label htmlFor="timezone">Timezone</label>
        <select id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="feedSize">Clips per day ({feedSize})</label>
        <input id="feedSize" type="range" min={min} max={max} value={feedSize} onChange={(e) => setFeedSize(Number(e.target.value))} />
        <span className="hint">Roughly one clip a minute fills the hour comfortably around 40.</span>
      </div>
      {msg && <p className={msg.kind === "ok" ? "success" : "error"}>{msg.text}</p>}
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? "Saving…" : "Save"}
      </button>
      <p className="hint" style={{ marginTop: 14 }}>
        {win.isOpen ? (
          <>
            Open now, closes in <Countdown target={win.closesAt} />.
          </>
        ) : (
          <>
            Next opens in <Countdown target={win.opensAt} />.
          </>
        )}
      </p>
    </form>
  );
}
