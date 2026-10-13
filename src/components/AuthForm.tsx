"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/lib/client-api";
import { safeNextPath } from "@/lib/safe-path";
import { googleStartHref, SIGN_IN_WITH_GOOGLE, signInNotice } from "@/lib/site-config";
import { useForgetParam, useSiteConfig } from "@/lib/site-config-client";

export function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A Google sign-in that came back without one says why, once: the word is read here and the
  // address put back below, so a reload says nothing. It is said only where /api/config says
  // sign in with Google is on: anywhere else no sign-in sent it, and anyone can write a link
  // that puts a Google message on a deployment that has none.
  const [signin, setSignin] = useState(() => params.get("signin"));
  const [busy, setBusy] = useState(false);
  const site = useSiteConfig();
  useForgetParam("signin", params.has("signin"));
  const shown = error ?? (site?.google ? signInNotice(signin) : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSignin(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
    await requestJson(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, timezone }),
    });
    router.push(safeNextPath(params.get("next"), mode === "signup" ? "/connect" : "/feed"));
    router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
          Create account
        </button>
        <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
          Sign in
        </button>
      </div>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <div className="field">
            <label htmlFor="displayName">Display name</label>
            <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" required />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={8}
            required
          />
          {mode === "signup" && <span className="hint">At least 8 characters. Your timezone is detected automatically.</span>}
        </div>
        {shown && <p className="error">{shown}</p>}
        <button className="btn btn-primary btn-block" disabled={busy} type="submit">
          {busy ? "One moment…" : mode === "signup" ? "Start my Daily Scroll" : "Sign in"}
        </button>
      </form>
      {/* Drawn only in the browser, once /api/config has answered, so the browser's own
          timezone can go with it for an account the sign-in makes; the server checks both. */}
      {site?.google && (
        <div className="auth-alt">
          <a className="btn btn-ghost btn-block" href={googleStartHref(params.get("next"), Intl.DateTimeFormat().resolvedOptions().timeZone)}>
            {SIGN_IN_WITH_GOOGLE}
          </a>
          <p className="hint">A new Google account makes a new account here. To sign in to an account you made with a password, link Google from Settings first.</p>
        </div>
      )}
    </div>
  );
}
