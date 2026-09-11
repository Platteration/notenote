"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Countdown } from "./Countdown";
import { PlatformLogo } from "./PlatformLogo";
import type { ConnectionSummary } from "@/lib/connections";
import type { DailyWindow } from "@/lib/window";

const ERRORS: Record<string, string> = {
  "unknown-provider": "That platform isn't supported.",
  denied: "You cancelled the authorisation.",
  "missing-code": "The platform didn't return an authorisation code.",
  "bad-state": "The sign-in link expired or didn't match. Try again.",
  "not-configured": "That platform has no OAuth credentials configured on the server.",
  "exchange-failed": "The platform rejected the token exchange. Check the server logs.",
};

/**
 * The sentence shown for an `?error=` a callback (or anyone with a link) put in the URL.
 *
 * An own-property lookup, and a string or the fallback. `ERRORS` is an object literal, so a bare
 * index answers `__proto__` with `Object.prototype` and `constructor` with a function — neither
 * of them nullish, so `??` never fires and React is handed something it cannot render, which
 * throws and takes the whole Connections panel down for that page load: no platform list, no
 * connect or disconnect buttons, no credential form.
 */
export function connectErrorText(param: string): string {
  const key = param.replace(/^[a-z]+-/, "");
  const text = Object.prototype.hasOwnProperty.call(ERRORS, key) ? ERRORS[key] : undefined;
  return typeof text === "string" ? text : "Something went wrong.";
}

function CredentialForm({
  connection,
  onConnected,
  onCancel,
}: {
  connection: ConnectionSummary;
  onConnected: (c: ConnectionSummary[]) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/connect/${connection.provider}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; connections?: ConnectionSummary[] };
    setBusy(false);
    if (!res.ok || !body.connections) {
      setError(body.error ?? "Could not connect");
      return;
    }
    onConnected(body.connections);
  }

  return (
    <form className="cred-form" onSubmit={submit}>
      {connection.credentialHelp && <p className="hint" style={{ marginBottom: 12 }}>{connection.credentialHelp}</p>}
      {(connection.credentialFields ?? []).map((f) => (
        <div className="field" key={f.name}>
          <label htmlFor={`${connection.provider}-${f.name}`}>{f.label}</label>
          <input
            id={`${connection.provider}-${f.name}`}
            type={f.type}
            placeholder={f.placeholder}
            required={f.required}
            autoComplete={f.type === "password" ? "off" : "on"}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
          />
          {f.help && <span className="hint">{f.help}</span>}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="cred-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? "Connecting…" : `Connect ${connection.name}`}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ConnectionsPanel({ initial, window: win }: { initial: ConnectionSummary[]; window: DailyWindow }) {
  const params = useSearchParams();
  const [connections, setConnections] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<string | null>(params.get("form"));
  const [justConnected, setJustConnected] = useState<string | null>(params.get("connected"));

  const errorParam = params.get("error");
  const errorText = errorParam ? connectErrorText(errorParam) : null;

  async function disconnect(provider: string) {
    setBusy(provider);
    const res = await fetch(`/api/connect/${provider}`, { method: "DELETE" });
    if (res.ok) setConnections(((await res.json()) as { connections: ConnectionSummary[] }).connections);
    setBusy(null);
  }

  /** Demo connections are created with a POST, never a link — see the route for why. */
  async function connectDemo(provider: string) {
    setBusy(provider);
    const res = await fetch(`/api/connect/${provider}`, { method: "POST" });
    if (res.ok) {
      setConnections(((await res.json()) as { connections: ConnectionSummary[] }).connections);
      setJustConnected(provider);
      setOpenForm(null);
    }
    setBusy(null);
  }

  const connectedCount = connections.filter((c) => c.connected).length;
  const justConnectedRow = connections.find((c) => c.provider === justConnected);

  return (
    <>
      {justConnectedRow && (
        <p className="success">
          Connected {justConnectedRow.name}
          {justConnectedRow.demo ? " in demo mode" : ""}.
        </p>
      )}
      {errorText && <p className="error">{errorText}</p>}

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>{win.isOpen ? "The scroll is open" : "Next scroll"}</h2>
        <p>
          {win.isOpen ? (
            <>
              Closes in <Countdown target={win.closesAt} />.{" "}
              <Link href="/feed" style={{ textDecoration: "underline" }}>
                Go scroll
              </Link>
              .
            </>
          ) : (
            <>
              Opens in <Countdown target={win.opensAt} /> ({win.windowStart} {win.timezone}). {connectedCount} platform
              {connectedCount === 1 ? "" : "s"} connected.
            </>
          )}
        </p>
      </div>

      {connections.map((c) => (
        <div className="card" key={c.provider}>
          <div className="provider">
            <PlatformLogo provider={c.provider} size={44} />
            <div className="provider-body">
              <strong>
                {c.name}{" "}
                {c.connected ? (
                  <span className={`badge ${c.needsReconnect ? "badge-off" : c.demo ? "badge-demo" : "badge-live"}`}>
                    {c.needsReconnect ? "reconnect" : c.demo ? "demo" : "live"}
                  </span>
                ) : (
                  <span className="badge badge-off">
                    {c.demoOnly ? "no public api" : c.credentialsConfigured ? "ready" : "demo available"}
                  </span>
                )}
              </strong>
              <span>
              {c.needsReconnect
                ? "This connection's stored tokens can't be read any more. Disconnect and connect again."
                : c.connected
                  ? c.displayName
                  : c.capability}
            </span>
            </div>
            {c.connected ? (
              <button className="btn btn-danger btn-sm" disabled={busy === c.provider} onClick={() => disconnect(c.provider)} type="button">
                Disconnect
              </button>
            ) : c.connectMode === "credentials" ? (
              <div className="provider-actions">
                <button className="btn btn-sm" type="button" onClick={() => setOpenForm(openForm === c.provider ? null : c.provider)}>
                  Connect
                </button>
                <button className="link-muted" type="button" disabled={busy === c.provider} onClick={() => connectDemo(c.provider)}>
                  or try demo
                </button>
              </div>
            ) : c.credentialsConfigured ? (
              <div className="provider-actions">
                <a className="btn btn-sm" href={`/api/connect/${c.provider}/start`}>
                  Connect
                </a>
                <button className="link-muted" type="button" disabled={busy === c.provider} onClick={() => connectDemo(c.provider)}>
                  or try demo
                </button>
              </div>
            ) : (
              <button className="btn btn-sm" type="button" disabled={busy === c.provider} onClick={() => connectDemo(c.provider)}>
                Try demo
              </button>
            )}
          </div>
          {!c.connected && openForm === c.provider && c.connectMode === "credentials" && (
            <CredentialForm
              connection={c}
              onCancel={() => setOpenForm(null)}
              onConnected={(list) => {
                setConnections(list);
                setOpenForm(null);
                setJustConnected(c.provider);
              }}
            />
          )}
        </div>
      ))}

      <p className="footer-note">
        Demo connections serve a generated catalogue that changes daily. Set the platform&apos;s client ID and secret in
        the server environment to switch it to a real OAuth connection. Operators can limit which platforms appear
        with the <code>ENABLED_PROVIDERS</code> setting.
      </p>
    </>
  );
}
