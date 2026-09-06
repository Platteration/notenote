"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, timezone }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Something went wrong");
      return;
    }
    const next = params.get("next");
    router.push(next && next.startsWith("/") ? next : mode === "signup" ? "/connect" : "/feed");
    router.refresh();
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
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy} type="submit">
          {busy ? "One moment…" : mode === "signup" ? "Start my Daily Scroll" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
