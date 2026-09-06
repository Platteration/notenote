"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Countdown } from "./Countdown";
import { PlatformLogo } from "./PlatformLogo";
import type { FeedPayload } from "@/lib/feed";
import { openInNativeApp } from "@/lib/open-native";
import { providerName } from "@/lib/providers/meta";
import type { MediaItem } from "@/lib/providers/types";

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

function Slide({ item, index, onVisible }: { item: MediaItem; index: number; onVisible: (key: string) => void }) {
  const ref = useRef<HTMLElement>(null);
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
          <video src={item.videoUrl} poster={item.thumbnailUrl ?? undefined} playsInline muted loop autoPlay preload="metadata" />
        ) : item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnailUrl} alt="" loading={index < 2 ? "eager" : "lazy"} />
        ) : (
          <div className="fallback">▶</div>
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
        </div>
      </div>
    </article>
  );
}

export function ScrollView({ initial }: { initial: FeedPayload }) {
  const router = useRouter();
  const { items, window: win } = initial;
  const listRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(false);
  const [current, setCurrent] = useState(0);
  const seenRef = useRef<Set<string>>(new Set(initial.seenKeys));
  const pendingRef = useRef<Set<string>>(new Set());

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
      if (idx >= 0) setCurrent(idx);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      pendingRef.current.add(key);
    },
    [items],
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

  const close = useCallback(() => setClosed(true), []);

  // Time-remaining bar.
  const [pct, setPct] = useState(100);
  useEffect(() => {
    const total = win.closesAt - win.opensAt;
    const tick = () => setPct(Math.max(0, Math.min(100, ((win.closesAt - Date.now()) / total) * 100)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [win.closesAt, win.opensAt]);

  const sourcesLine = useMemo(
    () =>
      initial.sources
        .filter((s) => s.count > 0)
        .map((s) => `${s.count} ${providerName(s.provider)}`)
        .join(" · "),
    [initial.sources],
  );

  return (
    <div className="scroll-shell">
      <header className="scroll-top">
        <div className="scroll-top-row">
          <Link href="/connect">← Exit</Link>
          <span>
            {Math.min(current + 1, items.length)} / {items.length}
          </span>
          <span>
            <Countdown target={win.closesAt} onZero={close} /> left
          </span>
        </div>
        <div className="timebar" aria-hidden>
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
          <Slide key={item.key} item={item} index={i} onVisible={onVisible} />
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

      {closed && (
        <div className="closing" role="dialog" aria-modal="true">
          <div>
            <h2>Time&apos;s up.</h2>
            <p style={{ color: "rgba(255,255,255,0.7)", marginBottom: 20 }}>Your hour is over. The scroll reopens tomorrow.</p>
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
          </div>
        </div>
      )}
    </div>
  );
}
