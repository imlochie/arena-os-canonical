"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  explicitDraftTargetAction,
  getArenaRoom,
  roomTitle,
} from "@/lib/arena-rooms";
import {
  clearArenaHandoffDrafts,
  readArenaHandoffDrafts,
  writeArenaHandoffDrafts,
  type ArenaHandoffDraft,
  type ArenaHandoffDraftStatus,
} from "@/lib/arena-handoff-drafts";

type Filter = "all" | ArenaHandoffDraftStatus;

function formattedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ArenaHandoffDraftLedger() {
  const [drafts, setDrafts] = useState<ArenaHandoffDraft[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setActionError(null);
    const result = readArenaHandoffDrafts();
    if (result.ok) {
      setDrafts(result.value);
      setStorageError(null);
    } else {
      setDrafts([]);
      setStorageError(result.error);
    }
    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleDrafts = useMemo(
    () => filter === "all" ? drafts : drafts.filter((draft) => draft.status === filter),
    [drafts, filter],
  );

  function persist(transform: (current: ArenaHandoffDraft[]) => ArenaHandoffDraft[]) {
    setActionError(null);
    const current = readArenaHandoffDrafts();
    if (!current.ok) {
      setStorageError(current.error);
      return;
    }
    const next = transform(current.value);
    const result = writeArenaHandoffDrafts(next);
    if (!result.ok) {
      setStorageError(result.error);
      return;
    }
    setDrafts(next);
    setStorageError(null);
  }

  function markReviewed(id: string) {
    persist((current) => current.map((draft) => draft.id === id ? { ...draft, status: "reviewed" } : draft));
  }

  function deleteDraft(id: string) {
    if (!window.confirm("Delete this browser-local draft?")) return;
    persist((current) => current.filter((draft) => draft.id !== id));
  }

  function clearAll() {
    if (!window.confirm("Clear every browser-local handoff draft? This does not change persisted Arena handoffs.")) return;
    const result = clearArenaHandoffDrafts();
    if (!result.ok) {
      setStorageError(result.error);
      return;
    }
    setDrafts([]);
    setStorageError(null);
  }

  async function copyPayload(draft: ArenaHandoffDraft) {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(draft.payload);
      setCopiedId(draft.id);
      window.setTimeout(() => setCopiedId((current) => current === draft.id ? null : current), 1_600);
    } catch {
      setActionError("The payload could not be copied. Your browser did not grant clipboard access.");
    }
  }

  return (
    <section className="arena-handoff-ledger" aria-labelledby="arena-handoff-ledger-title" data-testid="arena-handoff-draft-ledger">
      <header className="arena-ledger-header">
        <div>
          <p className="arena-rooms-kicker">Browser-local review queue</p>
          <h1 id="arena-handoff-ledger-title">Handoff drafts</h1>
          <p>These records are optional local notes. They do not submit payloads, create artifacts, or replace canonical persisted <code>arena_room_handoffs</code> records.</p>
        </div>
        <div className="arena-ledger-header-actions">
          <Link href="/rooms">Browse rooms</Link>
          <button type="button" onClick={clearAll} disabled={!drafts.length && !storageError} data-testid="arena-drafts-clear-all">Clear local drafts</button>
        </div>
      </header>

      <div className="arena-ledger-toolbar">
        <div role="group" aria-label="Filter local drafts">
          {(["all", "queued", "reviewed"] as const).map((candidate) => (
            <button key={candidate} type="button" aria-pressed={filter === candidate} onClick={() => setFilter(candidate)}>
              {candidate}
            </button>
          ))}
        </div>
        <button type="button" onClick={load}>Refresh local drafts</button>
      </div>

      {storageError ? <p className="arena-draft-message error" role="alert">{storageError}</p> : null}
      {actionError ? <p className="arena-draft-message error" role="alert">{actionError}</p> : null}

      {loading ? <p className="arena-ledger-empty">Reading local drafts…</p> : visibleDrafts.length === 0 ? (
        <div className="arena-ledger-empty">
          <h2>{filter === "all" ? "No local drafts" : `No ${filter} drafts`}</h2>
          <p>Start in a discovery room when you have context worth reviewing. Nothing will send automatically.</p>
          <Link href="/rooms">Browse discovery rooms →</Link>
        </div>
      ) : (
        <div className="arena-draft-list">
          {visibleDrafts.map((draft) => {
            const source = getArenaRoom(draft.fromRoomId);
            const destination = getArenaRoom(draft.toRoomId);
            const targetAction = explicitDraftTargetAction(draft.toRoomId);
            const planning = draft.targetKind === "planning";
            return (
              <article className="arena-draft-card" key={draft.id} data-testid={`arena-draft-${draft.id}`}>
                <div className="arena-draft-card-header">
                  <div>
                    <div className="arena-draft-badges">
                      <span className={draft.status === "reviewed" ? "reviewed" : "queued"}>{draft.status}</span>
                      <span className={planning ? "planning" : "operational"}>{planning ? "planning reference" : "operational destination"}</span>
                    </div>
                    <h2>{draft.title}</h2>
                    <p>{formattedDate(draft.createdAt)}</p>
                  </div>
                  <div className="arena-draft-card-buttons">
                    {draft.status === "queued" ? <button type="button" onClick={() => markReviewed(draft.id)}>Mark reviewed</button> : null}
                    <button type="button" onClick={() => deleteDraft(draft.id)}>Delete</button>
                  </div>
                </div>

                <div className="arena-draft-route">
                  <Link href={`/rooms/${draft.fromRoomId}`}>{source ? roomTitle(source) : draft.fromRoomId}</Link>
                  <span aria-hidden>→</span>
                  <Link href={`/rooms/${draft.toRoomId}`}>{destination ? roomTitle(destination) : draft.toRoomId}</Link>
                  {draft.arenaProjectId ? <Link href={`/projects/${draft.arenaProjectId}`}>Arena project reference</Link> : <span>No Arena project reference</span>}
                </div>

                <div className="arena-draft-payload">
                  <div>
                    <strong>Context</strong>
                    <button type="button" onClick={() => void copyPayload(draft)} data-testid={`arena-draft-copy-${draft.id}`}>
                      {copiedId === draft.id ? "Copied" : "Copy context"}
                    </button>
                  </div>
                  <pre>{draft.payload}</pre>
                </div>

                <div className="arena-draft-next-step">
                  {targetAction?.kind === "open-operational-room" ? (
                    <Link href={targetAction.href} data-testid={`arena-draft-open-${draft.id}`}>Open destination without sending context →</Link>
                  ) : (
                    <span>This is a planning reference only; no executable destination is available.</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
