"use client";

import { useState } from "react";

export function SecurityPanel({ initialSessions }: { initialSessions: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [sessions, setSessions] = useState(initialSessions);
  const [open, setOpen] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setMessage({ kind: "err", text: "The new passwords don't match" });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    const body = (await res.json()) as { error?: string; revokedSessions?: number };
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: "err", text: body.error ?? "Could not change the password" });
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    setOpen(false);
    setSessions(1);
    const revoked = body.revokedSessions ?? 0;
    setMessage({
      kind: "ok",
      text: revoked > 0
        ? `Password changed. ${revoked} other device${revoked === 1 ? " was" : "s were"} signed out.`
        : "Password changed.",
    });
  }

  async function signOutOthers() {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/account/sessions", { method: "DELETE" });
    const body = (await res.json()) as { revoked?: number; sessions?: number };
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: "err", text: "Could not sign out the other devices" });
      return;
    }
    setSessions(body.sessions ?? 1);
    setMessage({
      kind: "ok",
      text: body.revoked ? `Signed out ${body.revoked} other device${body.revoked === 1 ? "" : "s"}.` : "No other devices were signed in.",
    });
  }

  return (
    <div className="card">
      <h2>Password and devices</h2>
      <p>
        {sessions <= 1
          ? "This is the only device signed in."
          : `${sessions} devices are signed in, including this one.`}
      </p>
      {message && <p className={message.kind === "ok" ? "success" : "error"}>{message.text}</p>}
      <div className="cred-actions" style={{ marginTop: 14 }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen((v) => !v)}>
          Change password
        </button>
        {sessions > 1 && (
          <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={signOutOthers}>
            Sign out other devices
          </button>
        )}
      </div>
      {open && (
        <form className="cred-form" onSubmit={submit}>
          <p className="hint" style={{ marginBottom: 10 }}>
            Changing your password signs out every other device.
          </p>
          <div className="field">
            <label htmlFor="currentPassword">Current password</label>
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">New password</label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
            <span className="hint">At least 8 characters.</span>
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">Confirm new password</label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <div className="cred-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy ? "Changing…" : "Change password"}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
