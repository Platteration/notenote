"use client";

import Link from "next/link";
import { useState } from "react";
import { requestJson } from "@/lib/client-api";
import { PlatformLogo } from "./PlatformLogo";
import type { MutedCreator, SavedItem } from "@/lib/library";
import { openInNativeApp } from "@/lib/open-native";
import { providerName } from "@/lib/providers/meta";

function when(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function SavedShelf({ initial, initialMuted }: { initial: SavedItem[]; initialMuted: MutedCreator[] }) {
  const [saved, setSaved] = useState(initial);
  const [muted, setMuted] = useState(initialMuted);
  const [error, setError] = useState<string | null>(null);

  async function remove(key: string) {
    setError(null);
    try {
      await requestJson(`/api/saved?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      setSaved((list) => list.filter((s) => s.item.key !== key));
    } catch (err) { setError((err as Error).message); }
  }

  async function unmute(provider: string, creatorHandle: string) {
    setError(null);
    try {
    const body = await requestJson<{ muted: MutedCreator[] }>(`/api/muted?provider=${encodeURIComponent(provider)}&creatorHandle=${encodeURIComponent(creatorHandle)}`, {
      method: "DELETE",
    });
    setMuted(body.muted);
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {saved.length === 0 ? (
        <div className="card">
          <h2>Nothing saved yet</h2>
          <p>
            Tap <strong>Save</strong> on a clip during your hour and it will wait for you here.{" "}
            <Link href="/feed" style={{ textDecoration: "underline" }}>
              Go to the scroll
            </Link>
            .
          </p>
        </div>
      ) : (
        saved.map(({ item, savedAt }) => (
          <div className="card saved-card" key={item.key}>
            <PlatformLogo provider={item.provider} size={40} />
            <div className="saved-body">
              <strong>{item.title}</strong>
              <span>
                {item.creator} · saved {when(savedAt)}
              </span>
            </div>
            <div className="provider-actions">
              {item.demo ? <span className="badge badge-demo">demo</span> : <a
                className="btn btn-sm"
                href={item.permalink}
                onClick={(e) => {
                  e.preventDefault();
                  openInNativeApp(item);
                }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
              </a>}
              <button className="link-muted" type="button" onClick={() => remove(item.key)}>
                remove
              </button>
            </div>
          </div>
        ))
      )}

      {muted.length > 0 && (
        <div className="card" style={{ marginTop: 24 }}>
          <h2>Muted creators</h2>
          <p>These never appear in your feed. Unmute any time.</p>
          <div className="recap-row">
            {muted.map((m) => (
              <span className="recap-chip" key={`${m.provider}:${m.creatorHandle}`}>
                <PlatformLogo provider={m.provider} size={20} title={providerName(m.provider)} />
                @{m.creatorHandle}
                <button className="link-muted" type="button" onClick={() => unmute(m.provider, m.creatorHandle)}>
                  unmute
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
