"use client";

import { useId, useState } from "react";
import { PlatformLogo } from "./PlatformLogo";
import type { Collection } from "@/lib/archive";
import { MAX_NOTE_LENGTH } from "@/lib/archive-limits";
import { removeFromArchive } from "@/lib/archive-client";
import { requestJson } from "@/lib/client-api";
import type { SavedItem } from "@/lib/library";
import { openInNativeApp } from "@/lib/open-native";

function when(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** One clip in the archive: open it, note it, file it, or remove it. */
export function ArchiveCard({
  entry,
  collections,
  onChange,
  onRemoved,
  onError,
}: {
  entry: SavedItem;
  collections: Collection[];
  /** The clip changed (note or collections); the page refreshes its collection counts. */
  onChange: (next: SavedItem) => void;
  onRemoved: (key: string) => void;
  onError: (message: string) => void;
}) {
  const { item, savedAt, note } = entry;
  const noteId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [busy, setBusy] = useState(false);
  const filedIn = collections.filter((c) => entry.collections.includes(c.id));
  const notFiledIn = collections.filter((c) => !entry.collections.includes(c.id));

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const saveNote = () =>
    run(async () => {
      const { saved } = await requestJson<{ saved: SavedItem }>("/api/saved/note", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: item.key, note: draft }),
      });
      onChange(saved);
      setEditing(false);
    });

  const file = (collectionId: string) =>
    run(async () => {
      const { saved } = await requestJson<{ saved: SavedItem }>(`/api/collections/${encodeURIComponent(collectionId)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: item.key }),
      });
      onChange(saved);
    });

  const unfile = (collectionId: string) =>
    run(async () => {
      const { saved } = await requestJson<{ saved: SavedItem }>(
        `/api/collections/${encodeURIComponent(collectionId)}/items?key=${encodeURIComponent(item.key)}`,
        { method: "DELETE" },
      );
      onChange(saved);
    });

  const remove = () =>
    run(async () => {
      const annotated = note !== "" || entry.collections.length > 0;
      if (await removeFromArchive(item.key, annotated, (q) => window.confirm(q))) onRemoved(item.key);
    });

  return (
    <div className="card saved-card">
      <PlatformLogo provider={item.provider} size={40} />
      <div className="saved-body">
        <strong>{item.title}</strong>
        <span>
          {item.creator} · saved {when(savedAt)}
        </span>
      </div>
      <div className="archive-actions">
        {item.demo ? (
          <span className="badge badge-demo">demo</span>
        ) : (
          <a
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
          </a>
        )}
        {!editing && (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              setDraft(note);
              setEditing(true);
            }}
          >
            {note ? "Edit note" : "Add a note"}
          </button>
        )}
        {notFiledIn.length > 0 && (
          <select
            className="archive-select"
            aria-label="Add to collection"
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void file(e.target.value);
            }}
          >
            <option value="">Add to…</option>
            {notFiledIn.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button className="link-muted" type="button" onClick={() => void remove()} disabled={busy}>
          remove
        </button>
      </div>
      {filedIn.length > 0 && (
        <div className="saved-collections">
          {filedIn.map((c) => (
            <span className="recap-chip archive-chip" key={c.id}>
              {c.name}
              <button className="chip-remove" type="button" aria-label={`Take out of ${c.name}`} onClick={() => void unfile(c.id)} disabled={busy}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <div className="saved-note field">
          <label htmlFor={noteId}>Note</label>
          <textarea id={noteId} rows={3} maxLength={MAX_NOTE_LENGTH} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <span className="note-count">
            {draft.length}/{MAX_NOTE_LENGTH}
          </span>
          <div className="cred-actions">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void saveNote()} disabled={busy}>
              {busy ? "Saving…" : "Save note"}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        note && <p className="saved-note note-text">{note}</p>
      )}
    </div>
  );
}
