"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Countdown } from "./Countdown";
import { PlatformLogo } from "./PlatformLogo";
import { chime, haptic, scrollBehavior } from "@/lib/effects";
import type { FeedPayload } from "@/lib/feed";
import { openInNativeApp } from "@/lib/open-native";
import { PROVIDER_META, providerName } from "@/lib/providers/meta";
import type { MediaItem, ProviderId } from "@/lib/providers/types";
import type { Prefs } from "@/lib/settings";

function compact(n: number | undefined): string {
  if (n == null) return "–";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function ago(ms: number): string {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Slide({
  item,
  index,
  active,
  soundOn,
  saved,
  onVisible,
  onSave,
  onMute,
}: {
  item: MediaItem;
  index: number;
  active: boolean;
  soundOn: boolean;
  saved: boolean;
  onVisible: (key: string) => void;
  onSave: (item: MediaItem) => void;
  onMute: (item: MediaItem) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Only the clip on screen plays, so the hour doesn't cost forty videos of bandwidth.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !soundOn;
    if (active) void v.play().catch(() => {});
    else v.pause();
  }, [active, soundOn]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) onVisible(item.key);
      },
      { threshold: [0.6] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [item.key, onVisible]);

  const name = providerName(item.provider);
  const brand = PROVIDER_META[item.provider as ProviderId]?.color ?? "#333";
  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    openInNativeApp(item);
  };
  return (
    <article className="slide" ref={ref} data-index={index} aria-label={item.title}>
      <a
        className="slide-tap"
        href={item.permalink}
        onClick={open}
        aria-label={`Open on ${name}`}
        target="_blank"
        rel="noopener noreferrer"
      />
      <span className="slide-source">
        <PlatformLogo provider={item.provider} size={44} title={`From ${name}`} />
      </span>
      <div className="slide-media">
        {item.videoUrl ? (
          <video
            ref={videoRef}
            src={item.videoUrl}
            poster={item.thumbnailUrl ?? undefined}
            playsInline
            muted
            loop
            preload={index < 2 ? "auto" : "none"}
          />
        ) : item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnailUrl} alt="" loading={index < 2 ? "eager" : "lazy"} />
        ) : (
          <div className="fallback" style={{ ["--brand" as string]: brand }}>
            ▶
          </div>
        )}
      </div>
      <div className="slide-shade" />
      <div className="slide-body">
        <div className="slide-meta">
          <span className="chip">{name}</span>
          {item.durationSeconds != null && <span className="chip">{item.durationSeconds}s</span>}
          <span className="chip">{ago(item.publishedAt)}</span>
        </div>
        <h2 className="slide-title">{item.title}</h2>
        <p className="slide-creator">
          {item.creator} · @{item.creatorHandle}
        </p>
        <div className="slide-stats">
          {item.metrics.views != null && <span>{compact(item.metrics.views)} views</span>}
          {item.metrics.likes != null && <span>{compact(item.metrics.likes)} likes</span>}
          {item.metrics.comments != null && <span>{compact(item.metrics.comments)} comments</span>}
        </div>
        <div className="slide-actions">
          <a className="btn" href={item.permalink} onClick={open} target="_blank" rel="noopener noreferrer">
            Open in {name}
          </a>
          <button
            className="btn btn-ghost"
            type="button"
            aria-pressed={saved}
            onClick={(e) => {
              e.stopPropagation();
              onSave(item);
            }}
          >
            {saved ? "Saved" : "Save"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            title={`See less from ${item.creator}`}
            onClick={(e) => {
              e.stopPropagation();
              onMute(item);
            }}
          >
            Less like this
          </button>
        </div>
      </div>
    </article>
  );
}

export function ScrollView({ initial, prefs }: { initial: FeedPayload; prefs: Prefs }) {
  const router = useRouter();
  const { items, window: win } = initial;
  const listRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(false);
  const [current, setCurrent] = useState(0);
  const seenRef = useRef<Set<string>>(new Set(initial.seenKeys));
  const watchedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set(initial.savedKeys));
  const [mutedKeys, setMutedKeys] = useState<Set<string>>(() => new Set());
  const [soundOn, setSoundOn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const hasVideo = useMemo(() => items.some((i) => i.videoUrl), [items]);

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2200);
  }, []);

  /** Saving keeps a copy of the clip that outlives the hour. */
  const onSave = useCallback(
    async (item: MediaItem) => {
      const already = savedKeys.has(item.key);
      setSavedKeys((prev) => {
        const next = new Set(prev);
        if (already) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      haptic(prefs, 10);
      if (already) {
        await fetch(`/api/saved?key=${encodeURIComponent(item.key)}`, { method: "DELETE" });
        flash("Removed from saved");
      } else {
        const res = await fetch("/api/saved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: item.key }),
        });
        flash(res.ok ? "Saved for later" : "Could not save that one");
      }
    },
    [savedKeys, prefs, flash],
  );

  /** Muting hides the creator from every future feed, and dims them for the rest of today. */
  const onMute = useCallback(
    async (item: MediaItem) => {
      setMutedKeys((prev) => new Set(prev).add(item.key));
      haptic(prefs, 10);
      const res = await fetch("/api/muted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.provider, creatorHandle: item.creatorHandle }),
      });
      flash(res.ok ? `You'll see less from ${item.creator}` : "Could not mute that creator");
    },
    [prefs, flash],
  );

  // Flush "seen" marks in small batches so a fast swipe doesn't spam the API.
  useEffect(() => {
    const id = setInterval(() => {
      if (pendingRef.current.size === 0) return;
      const keys = [...pendingRef.current];
      pendingRef.current.clear();
      void fetch("/api/feed/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
        keepalive: true,
      });
    }, 2500);
    return () => clearInterval(id);
  }, []);

  const onVisible = useCallback(
    (key: string) => {
      const idx = items.findIndex((it) => it.key === key);
      if (idx >= 0) {
        setCurrent((prev) => {
          if (prev !== idx) haptic(prefs, 8);
          return idx;
        });
      }
      watchedRef.current.add(key);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      pendingRef.current.add(key);
    },
    [items, prefs],
  );

  // Resume where you left off within the hour.
  useEffect(() => {
    const firstUnseen = items.findIndex((it) => !seenRef.current.has(it.key));
    if (firstUnseen > 0 && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>(`[data-index="${firstUnseen}"]`);
      el?.scrollIntoView({ block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    setClosed(true);
    chime(prefs, "close");
    haptic(prefs, [40, 60, 120]);
  }, [prefs]);

  // Keyboard: ↓/j/space next, ↑/k previous, enter/o open the current clip in its app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closed) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const go = (delta: number) => {
        const next = Math.max(0, Math.min(items.length, current + delta));
        listRef.current
          ?.querySelector<HTMLElement>(`[data-index="${next}"], .end-slide`)
          ?.scrollIntoView({ block: "start", behavior: scrollBehavior(prefs) });
      };
      if (e.key === "ArrowDown" || e.key === "j" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        go(-1);
      } else if ((e.key === "Enter" || e.key === "o") && items[current]) {
        e.preventDefault();
        openInNativeApp(items[current]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closed, current, items, prefs]);

  // Time-remaining bar, plus a single nudge as the last minute begins.
  const [pct, setPct] = useState(100);
  const [finalMinute, setFinalMinute] = useState(false);
  const nudgedRef = useRef(false);
  useEffect(() => {
    const total = win.closesAt - win.opensAt;
    const tick = () => {
      const remaining = win.closesAt - Date.now();
      setPct(Math.max(0, Math.min(100, (remaining / total) * 100)));
      if (remaining <= 60_000 && remaining > 0) {
        setFinalMinute(true);
        if (!nudgedRef.current) {
          nudgedRef.current = true;
          haptic(prefs, [30, 40, 30]);
        }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [win.closesAt, win.opensAt, prefs]);

  const sourcesLine = useMemo(
    () =>
      initial.sources
        .filter((s) => s.count > 0)
        .map((s) => `${s.count} ${providerName(s.provider)}`)
        .join(" · "),
    [initial.sources],
  );

  // What the viewer actually watched this session, for the closing recap.
  const watchedByProvider = useMemo(() => {
    if (!closed) return [];
    const counts = new Map<string, number>();
    for (const item of items) {
      if (watchedRef.current.has(item.key)) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [closed, items]);
  const watchedTotal = watchedByProvider.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="scroll-shell">
      <header className="scroll-top">
        <div className="scroll-top-row">
          <Link href="/connect">← Exit</Link>
          <span>
            {Math.min(current + 1, items.length)} / {items.length}
          </span>
          <span className="scroll-top-right">
            {hasVideo && (
              <button
                type="button"
                className="sound-toggle"
                aria-pressed={soundOn}
                aria-label={soundOn ? "Mute clips" : "Unmute clips"}
                onClick={() => setSoundOn((v) => !v)}
              >
                {soundOn ? "🔊" : "🔇"}
              </button>
            )}
            <Countdown target={win.closesAt} onZero={close} /> left
          </span>
        </div>
        <div className={`timebar${finalMinute ? " final" : ""}`} aria-hidden>
          <div style={{ width: `${pct}%` }} />
        </div>
      </header>

      <div className="scroll-list" ref={listRef}>
        {items.length === 0 && (
          <section className="slide end-slide">
            <div>
              <h2>Nothing came through</h2>
              <p>
                Your connected platforms didn&apos;t return any short-form video this time.{" "}
                {initial.sources.some((s) => s.error) ? "At least one platform reported an error." : ""}
              </p>
              <Link className="btn" href="/connect">
                Check connections
              </Link>
            </div>
          </section>
        )}
        {items.map((item, i) => (
          <Slide
            key={item.key}
            item={item}
            index={i}
            active={i === current}
            soundOn={soundOn}
            saved={savedKeys.has(item.key)}
            onVisible={onVisible}
            onSave={onSave}
            onMute={onMute}
          />
        ))}
        {items.length > 0 && (
          <section className="slide end-slide">
            <div>
              <h2>That&apos;s the scroll.</h2>
              <p>
                {items.length} clips today{sourcesLine ? ` (${sourcesLine})` : ""}. Nothing more until tomorrow&apos;s hour.
              </p>
              <Link className="btn" href="/connect">
                Done for today
              </Link>
            </div>
          </section>
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {closed && (
        <div className="closing" role="dialog" aria-modal="true">
          <div className="closing-inner">
            <h2>That&apos;s your hour.</h2>
            <p className="closing-line">
              {watchedTotal > 0
                ? `You watched ${watchedTotal} clip${watchedTotal === 1 ? "" : "s"}.`
                : "Nothing watched today. That counts too."}
            </p>
            {watchedByProvider.length > 0 && (
              <div className="closing-stats">
                {watchedByProvider.map(([provider, count]) => (
                  <span className="closing-chip" key={provider} title={providerName(provider)}>
                    <PlatformLogo provider={provider} size={22} />
                    {count}
                  </span>
                ))}
              </div>
            )}
            <button
              className="btn"
              type="button"
              onClick={() => {
                router.push("/feed");
                router.refresh();
              }}
            >
              See when it reopens
            </button>
            <p className="sign-off">See you tomorrow.</p>
          </div>
        </div>
      )}
    </div>
  );
}
