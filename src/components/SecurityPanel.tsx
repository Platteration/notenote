"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/lib/client-api";
import { isGoogleConsentUrl, linkNotice } from "@/lib/site-config";
import { useForgetParam, useSiteConfig } from "@/lib/site-config-client";

/** The Google account that signs in here, as Settings shows it. */
export interface GoogleLinkState {
  linked: boolean;
  email: string | null;
}

/**
 * Sign in with Google, in Settings: which Google account signs in here, or a button that links
 * one to this account. Linking is only ever done from here, signed in: an account here is never
 * matched to a Google account by its email address. Drawn only when the deployment has sign in
 * with Google turned on.
 */
function GoogleRow({ google }: { google: GoogleLinkState }) {
  const site = useSiteConfig();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  // Back from Google: said once, then the address is put back, so a reload says nothing.
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(() => linkNotice(params.get("link")));
  useForgetParam("link", params.has("link"));

  async function link() {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await requestJson<{ url?: unknown }>("/api/account/google", { method: "POST" });
      if (!isGoogleConsentUrl(url)) throw new Error("Linking Google didn't start. Try again.");
      window.location.assign(url);
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
      setBusy(false);
    }
  }

  if (!site?.google) return null;
  return (
    <div className="account-row">
      <h3 className="pref-heading">Sign in with Google</h3>
      {google.linked ? (
        <p>{google.email ? `Linked to the Google account ${google.email}.` : "Linked to a Google account."} You can sign in with it.</p>
      ) : (
        <>
          <p>Link your Google account to sign in with it as well as your password.</p>
          <div className="cred-actions" style={{ marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void link()}>
              {busy ? "Opening Google…" : "Link Google"}
            </button>
          </div>
        </>
      )}
      {message && <p className={message.kind === "ok" ? "success" : "error"}>{message.text}</p>}
    </div>
  );
}

export function SecurityPanel({
  initialSessions,
  google,
  hasPassword,
}: {
  initialSessions: number;
  google: GoogleLinkState;
  /** An account made with Google has no password, so there is none to change. */
  hasPassword: boolean;
}) {
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
    try {
    const body = await requestJson<{ revokedSessions?: number }>("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
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
    } catch (err) { setMessage({ kind: "err", text: (err as Error).message }); }
    finally { setBusy(false); }
  }

  async function signOutOthers() {
    setBusy(true);
    setMessage(null);
    try {
    const body = await requestJson<{ revoked?: number; sessions?: number }>("/api/account/sessions", { method: "DELETE" });
    setSessions(body.sessions ?? 1);
    setMessage({
      kind: "ok",
      text: body.revoked ? `Signed out ${body.revoked} other device${body.revoked === 1 ? "" : "s"}.` : "No other devices were signed in.",
    });
    } catch (err) { setMessage({ kind: "err", text: (err as Error).message }); }
    finally { setBusy(false); }
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
      {!hasPassword && <p style={{ marginTop: 6 }}>This account signs in with Google. It has no password.</p>}
      {(hasPassword || sessions > 1) && (
        <div className="cred-actions" style={{ marginTop: 14 }}>
          {hasPassword && (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen((v) => !v)}>
              Change password
            </button>
          )}
          {sessions > 1 && (
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={signOutOthers}>
              Sign out other devices
            </button>
          )}
        </div>
      )}
      {open && hasPassword && (
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
      <GoogleRow google={google} />
    </div>
  );
}
