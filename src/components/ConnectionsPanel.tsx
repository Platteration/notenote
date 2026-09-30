"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/lib/client-api";
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
    try {
    const body = await requestJson<{ connections: ConnectionSummary[] }>(`/api/connect/${connection.provider}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    onConnected(body.connections);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
  const [error, setError] = useState<string | null>(null);

  const errorParam = params.get("error");
  const errorText = errorParam ? ERRORS[errorParam] ?? ERRORS[errorParam.replace(/^[a-z]+-/, "")] ?? "Something went wrong." : null;

  async function disconnect(provider: string) {
    setBusy(provider);
    setError(null);
    try {
      const body = await requestJson<{ connections: ConnectionSummary[] }>(`/api/connect/${provider}`, { method: "DELETE" });
      setConnections(body.connections);
      setJustConnected(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** Demo connections are created with a POST, never a link — see the route for why. */
  async function connectDemo(provider: string) {
    setBusy(provider);
    setError(null);
    try {
      const body = await requestJson<{ connections: ConnectionSummary[] }>(`/api/connect/${provider}`, { method: "POST" });
      setConnections(body.connections);
      setJustConnected(provider);
      setOpenForm(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
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
      {error && <p className="error" role="alert">{error}</p>}

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
                  <span className={`badge ${c.demo ? "badge-demo" : "badge-live"}`}>{c.demo ? "demo" : "live"}</span>
                ) : (
                  <span className="badge badge-off">
                    {c.demoOnly ? "no public api" : c.credentialsConfigured ? "ready" : "demo available"}
                  </span>
                )}
              </strong>
              <span>{c.connected ? c.displayName : c.capability}</span>
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
        Demo connections show sample clips so you can explore the app. Connect a live account to see content from your
        platforms. Each platform determines which videos it makes available.
      </p>
    </>
  );
}
