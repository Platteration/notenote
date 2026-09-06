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

export function ConnectionsPanel({ initial, window: win }: { initial: ConnectionSummary[]; window: DailyWindow }) {
  const params = useSearchParams();
  const [connections, setConnections] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  const connectedParam = params.get("connected");
  const errorParam = params.get("error");
  const errorText = errorParam ? ERRORS[errorParam.replace(/^[a-z]+-/, "")] ?? "Something went wrong." : null;

  async function disconnect(provider: string) {
    setBusy(provider);
    const res = await fetch(`/api/connect/${provider}`, { method: "DELETE" });
    if (res.ok) setConnections(((await res.json()) as { connections: ConnectionSummary[] }).connections);
    setBusy(null);
  }

  const connectedCount = connections.filter((c) => c.connected).length;

  return (
    <>
      {connectedParam && (
        <p className="success">
          Connected {connections.find((c) => c.provider === connectedParam)?.name ?? connectedParam}
          {params.get("demo") ? " in demo mode" : ""}.
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
            ) : (
              <a className="btn btn-sm" href={`/api/connect/${c.provider}/start`}>
                {c.credentialsConfigured ? "Connect" : "Try demo"}
              </a>
            )}
          </div>
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
