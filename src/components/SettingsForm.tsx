"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Countdown } from "./Countdown";
import { NotificationSetting } from "./NotificationSetting";
import { chime, haptic } from "@/lib/effects";
import type { Prefs, Settings, Theme } from "@/lib/settings";
import type { DailyWindow } from "@/lib/window";

function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="switch-row">
      <span className="switch-label">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function SettingsForm({
  initial,
  initialWindow,
  min,
  max,
  email,
}: {
  initial: Settings;
  initialWindow: DailyWindow;
  min: number;
  max: number;
  email: string;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [windowStart, setWindowStart] = useState(initial.windowStart);
  const [feedSize, setFeedSize] = useState(initial.feedSize);
  const [prefs, setPrefs] = useState<Prefs>(initial.prefs);
  const [win, setWin] = useState(initialWindow);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);

  /** Preferences save immediately and apply to the live page, so the change is visible. */
  async function updatePrefs(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    const root = document.documentElement;
    if (patch.theme !== undefined) {
      if (patch.theme === "system") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", patch.theme);
    }
    if (patch.reduceMotion !== undefined) {
      if (patch.reduceMotion) root.setAttribute("data-reduce-motion", "true");
      else root.removeAttribute("data-reduce-motion");
    }
    if (patch.haptics) haptic(next, 12);
    if (patch.sound) chime(next, "open");
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs: patch }),
    });
  }

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

  async function deleteAccount() {
    setDeleteError(null);
    const res = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: confirmEmail }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setDeleteError(body.error ?? "Could not delete the account");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <>
      <form className="card" onSubmit={save}>
        <h2>Your hour</h2>
        <div className="field" style={{ marginTop: 14 }}>
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

      <div className="card">
        <h2>Appearance</h2>
        <p style={{ marginBottom: 14 }}>The scroll itself stays dark. This changes everything around it.</p>
        <div className="segmented" role="group" aria-label="Theme">
          {(["system", "dark", "light"] as Theme[]).map((t) => (
            <button key={t} type="button" aria-pressed={prefs.theme === t} onClick={() => void updatePrefs({ theme: t })}>
              {t === "system" ? "System" : t === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8 }}>
          <Switch
            label="Reduce motion"
            description="Turn off gradient shifts, smooth scrolling and transitions."
            checked={prefs.reduceMotion}
            onChange={(v) => void updatePrefs({ reduceMotion: v })}
          />
          <Switch
            label="Haptics"
            description="A light tap as each clip passes, and a nudge when the final minute starts."
            checked={prefs.haptics}
            onChange={(v) => void updatePrefs({ haptics: v })}
          />
          <Switch
            label="Sound"
            description="A soft chime when the hour opens, a lower tone when it closes."
            checked={prefs.sound}
            onChange={(v) => void updatePrefs({ sound: v })}
          />
        </div>
      </div>

      <div className="card">
        <h2>Notifications</h2>
        <p style={{ marginBottom: 6 }}>
          The app sends exactly one message a day. There is no reminder that you missed it and no nudge to come back.
        </p>
        <NotificationSetting />
      </div>

      <div className="card">
        <h2>Your data</h2>
        <p>
          What you watched is yours and is never sold or shared. Take it with you, or remove it entirely.
        </p>
        <div className="cred-actions" style={{ marginTop: 14 }}>
          <a className="btn btn-ghost btn-sm" href="/api/account/export">
            Export my data
          </a>
          <button className="btn btn-danger btn-sm" type="button" onClick={() => setDeleteOpen((v) => !v)}>
            Delete my account
          </button>
        </div>
        {deleteOpen && (
          <div className="cred-form">
            <p className="hint" style={{ marginBottom: 10 }}>
              This removes your account, every connection and all watch history immediately. It cannot be undone. Type{" "}
              <strong>{email}</strong> to confirm.
            </p>
            <div className="field">
              <label htmlFor="confirmEmail">Confirm email</label>
              <input id="confirmEmail" type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" />
            </div>
            {deleteError && <p className="error">{deleteError}</p>}
            <div className="cred-actions">
              <button className="btn btn-danger btn-sm" type="button" onClick={deleteAccount} disabled={confirmEmail !== email}>
                Permanently delete
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDeleteOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
