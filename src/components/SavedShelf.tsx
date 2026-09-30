"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { requestJson } from "@/lib/client-api";
import { ArchiveCard } from "./ArchiveCard";
import { PlatformLogo } from "./PlatformLogo";
import type { Collection } from "@/lib/archive";
import { ARCHIVE_SEARCH_LIMIT, MAX_COLLECTION_NAME, MAX_SEARCH_QUERY } from "@/lib/archive-limits";
import type { MutedCreator, SavedItem } from "@/lib/library";
import { providerName } from "@/lib/providers/meta";

export function SavedShelf({
  initial,
  initialMuted,
  initialCollections,
}: {
  initial: SavedItem[];
  initialMuted: MutedCreator[];
  initialCollections: Collection[];
}) {
  const [saved, setSaved] = useState(initial);
  const [muted, setMuted] = useState(initialMuted);
  const [collections, setCollections] = useState(initialCollections);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [anySaved, setAnySaved] = useState(initial.length > 0);
  const firstRun = useRef(true);
  const activeCollection = collections.find((c) => c.id === active) ?? null;
  const filtering = query.trim() !== "" || active !== null;

  // Search as you type, a beat after the last keystroke, and drop an answer that went stale.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (active) params.set("collection", active);
      const url = params.size ? `/api/saved?${params}` : "/api/saved";
      requestJson<{ saved: SavedItem[] }>(url, { signal: controller.signal })
        .then((body) => {
          setSaved(body.saved);
          setError(null);
        })
        .catch((err: Error) => {
          if (!controller.signal.aborted) setError(err.message);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, active]);

  async function refreshCollections() {
    const body = await requestJson<{ collections: Collection[] }>("/api/collections");
    setCollections(body.collections);
  }

  async function act(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const createCollection = () =>
    act(async () => {
      await requestJson("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      setNewName("");
      await refreshCollections();
    });

  const renameCollection = (id: string, name: string) =>
    act(async () => {
      await requestJson(`/api/collections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setRenaming(null);
      await refreshCollections();
    });

  // A collection is only a grouping: its clips and their notes stay, so it goes without asking.
  const deleteCollection = (id: string) =>
    act(async () => {
      await requestJson(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
      setActive(null);
      setSaved((list) => list.map((s) => ({ ...s, collections: s.collections.filter((c) => c !== id) })));
      await refreshCollections();
    });

  function changed(next: SavedItem) {
    setSaved((list) =>
      list
        .map((s) => (s.item.key === next.item.key ? next : s))
        // Taken out of the collection being viewed: it no longer belongs in this view.
        .filter((s) => active === null || s.collections.includes(active)),
    );
    void refreshCollections().catch(() => {});
  }

  function removed(key: string) {
    setSaved((list) => {
      const rest = list.filter((s) => s.item.key !== key);
      if (!filtering && rest.length === 0) setAnySaved(false);
      return rest;
    });
    void refreshCollections().catch(() => {});
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
      {anySaved && (
        <div className="archive-tools">
          <div className="field">
            <label htmlFor="archive-q">Search</label>
            <input
              id="archive-q"
              type="search"
              maxLength={MAX_SEARCH_QUERY}
              placeholder="Title, creator, note or collection"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="recap-row archive-filters" role="group" aria-label="Collections">
            <button type="button" className="recap-chip" aria-pressed={active === null} onClick={() => setActive(null)}>
              All
            </button>
            {collections.map((c) => (
              <button key={c.id} type="button" className="recap-chip" aria-pressed={active === c.id} onClick={() => setActive(c.id)}>
                {c.name} · {c.count}
              </button>
            ))}
          </div>
          <form
            className="archive-new"
            onSubmit={(e) => {
              e.preventDefault();
              void createCollection();
            }}
          >
            <label className="visually-hidden" htmlFor="archive-new">
              New collection name
            </label>
            <input
              id="archive-new"
              className="archive-input"
              maxLength={MAX_COLLECTION_NAME}
              placeholder="New collection"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn btn-ghost btn-sm" type="submit" disabled={!newName.trim()}>
              Add
            </button>
          </form>
          {activeCollection && (
            <div className="archive-collection-actions">
              {renaming === activeCollection.id ? (
                <form
                  className="archive-new"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = new FormData(e.currentTarget).get("name");
                    void renameCollection(activeCollection.id, String(name ?? ""));
                  }}
                >
                  <label className="visually-hidden" htmlFor="archive-rename">
                    New name for {activeCollection.name}
                  </label>
                  <input id="archive-rename" name="name" className="archive-input" maxLength={MAX_COLLECTION_NAME} defaultValue={activeCollection.name} />
                  <button className="btn btn-ghost btn-sm" type="submit">
                    Save name
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRenaming(activeCollection.id)}>
                    Rename
                  </button>
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => void deleteCollection(activeCollection.id)}>
                    Delete collection
                  </button>
                  <span className="hint">Its clips and their notes stay in your archive.</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!anySaved ? (
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
      ) : saved.length === 0 ? (
        <div className="card">
          <h2>No clips match</h2>
          <p>Nothing in your archive matches that search{active ? " in this collection" : ""}.</p>
        </div>
      ) : (
        <>
          {saved.map((entry) => (
            <ArchiveCard
              key={entry.item.key}
              entry={entry}
              collections={collections}
              onChange={changed}
              onRemoved={removed}
              onError={(message) => setError(message)}
            />
          ))}
          {filtering && saved.length >= ARCHIVE_SEARCH_LIMIT && (
            <p className="hint">Showing the first {ARCHIVE_SEARCH_LIMIT} matches. Narrow the search to see more.</p>
          )}
        </>
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
