"use client";

import { useCallback, useEffect, useState } from "react";

/** base64url VAPID key → the Uint8Array the PushManager expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "loading" | "unsupported" | "unconfigured" | "off" | "on" | "blocked";

export function NotificationSetting() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    const res = await fetch("/api/push/key");
    const { configured } = (await res.json()) as { configured: boolean };
    if (!configured) {
      setState("unconfigured");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    setState(sub ? "on" : "off");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = (await (await fetch("/api/push/key")).json()) as { publicKey: string | null };
      if (!publicKey) throw new Error("This server has no push keys configured");
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not subscribe");
      setState("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn notifications on");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn notifications off");
    } finally {
      setBusy(false);
    }
  }

  const description: Record<State, string> = {
    loading: "Checking this device…",
    unsupported: "This browser doesn't support web push. Try installing the app to your home screen.",
    unconfigured: "The server has no push keys configured, so notifications are unavailable here.",
    off: "One notification a day, when your hour opens. Nothing else, ever.",
    on: "You'll get one notification a day, when your hour opens.",
    blocked: "Notifications are blocked for this site in your browser settings.",
  };

  return (
    <div className="switch-row">
      <span className="switch-label">
        <strong>Tell me when the hour opens</strong>
        <span>{description[state]}</span>
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </span>
      {(state === "on" || state === "off") && (
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={state === "on"}
          aria-label="Notify me when the hour opens"
          disabled={busy}
          onClick={() => void (state === "on" ? disable() : enable())}
        />
      )}
    </div>
  );
}
