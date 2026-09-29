"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  ARENA_OPERATIONAL_DESTINATIONS,
  ARENA_PLANNING_DESTINATIONS,
  explicitDraftTargetAction,
  getArenaRoom,
  roomTitle,
  type ArenaRoom,
} from "@/lib/arena-rooms";
import {
  ARENA_PROJECTS_ENDPOINT,
  createArenaHandoffDraft,
  readArenaHandoffDrafts,
  writeArenaHandoffDrafts,
} from "@/lib/arena-handoff-drafts";

type ArenaProjectOption = { id: string; name: string; emoji?: string | null };

function draftId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function ArenaRoomDetail({ room }: { room: ArenaRoom }) {
  const [title, setTitle] = useState("");
  const [toRoomId, setToRoomId] = useState("");
  const [arenaProjectId, setArenaProjectId] = useState("");
  const [payload, setPayload] = useState("");
  const [projects, setProjects] = useState<ArenaProjectOption[]>([]);
  const [projectsState, setProjectsState] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      try {
        const response = await fetch(ARENA_PROJECTS_ENDPOINT, { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { projects?: ArenaProjectOption[] };
        if (!response.ok || !Array.isArray(body.projects)) throw new Error("Arena projects could not be loaded.");
        if (!cancelled) setProjects(body.projects.map(({ id, name, emoji }) => ({ id, name, emoji })));
        if (!cancelled) setProjectsState("ready");
      } catch {
        if (!cancelled) setProjectsState("failed");
      }
    }
    void loadProjects();
    return () => { cancelled = true; };
  }, []);

  const action = explicitDraftTargetAction(room.id);
  const isOperational = room.availability === "operational";

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    const draft = createArenaHandoffDraft({
      id: draftId(),
      title,
      fromRoomId: room.id,
      toRoomId,
      arenaProjectId: arenaProjectId || null,
      payload,
    });
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    const current = readArenaHandoffDrafts();
    if (!current.ok) {
      setError(current.error);
      return;
    }
    const saved = writeArenaHandoffDrafts([draft.value, ...current.value]);
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setTitle("");
    setToRoomId("");
    setArenaProjectId("");
    setPayload("");
    setMessage(
      draft.value.targetKind === "operational"
        ? "Local draft saved. Review, copy, or explicitly open its destination from the draft ledger."
        : "Planning draft saved. This target has no executable room or transfer action.",
    );
  }

  return (
    <section className="arena-room-detail" aria-labelledby="arena-room-title" data-testid="arena-room-detail">
      <Link className="arena-room-back" href="/rooms">← All discovery rooms</Link>
      <div className="arena-room-detail-grid">
        <article className="arena-room-overview">
          <p className="arena-rooms-kicker">{room.label} room</p>
          <div className="arena-room-overview-title">
            <span aria-hidden>{room.emoji}</span>
            <h1 id="arena-room-title">{roomTitle(room)}</h1>
          </div>
          <p className="arena-room-description">{room.description}</p>

          {isOperational && action?.kind === "open-operational-room" ? (
            <div className="arena-room-status operational">
              <strong>Verified Arena surface</strong>
              <p>Opening this room is a navigation choice only. It does not include a draft payload or begin work.</p>
              <Link href={action.href} data-testid="arena-room-open-destination">Open {room.label} →</Link>
            </div>
          ) : (
            <div className="arena-room-status planning">
              <strong>Planning-only concept</strong>
              <p>This room has no connected service or executable transfer destination. It can be referenced only in a local planning draft.</p>
            </div>
          )}

          {room.id === "waveyard" ? (
            <div className="arena-room-boundary" data-testid="waveyard-metadata-boundary">
              <strong>Waveyard boundary</strong>
              <p>Waveyard owns private sources, stems, analysis, playback, and exports. Its established Arena adapter moves only explicit written metadata and provenance.</p>
            </div>
          ) : null}

          <div className="arena-room-principles">
            <div><strong>Review first</strong><span>Drafts are visible only in this browser until you copy or navigate.</span></div>
            <div><strong>No auto-send</strong><span>Saving a draft never submits its payload to an Arena or specialist-room API.</span></div>
            <div><strong>Canonical records stay separate</strong><span>Browser drafts do not replace persisted Arena room handoffs.</span></div>
          </div>
        </article>

        <form className="arena-draft-form" onSubmit={saveDraft} aria-describedby="arena-draft-help">
          <p className="arena-rooms-kicker">Optional local draft</p>
          <h2>Prepare context for review</h2>
          <p id="arena-draft-help">This creates a browser-local review record only. It does not send the payload, create an artifact, or alter canonical room handoff records.</p>

          <label>
            Title
            <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="A short draft name" data-testid="arena-draft-title" />
          </label>
          <label>
            From room
            <output>{roomTitle(room)}</output>
          </label>
          <label>
            Target
            <select value={toRoomId} onChange={(event) => setToRoomId(event.target.value)} data-testid="arena-draft-target">
              <option value="">Choose a target</option>
              <optgroup label="Operational destinations">
                {ARENA_OPERATIONAL_DESTINATIONS.filter((candidate) => candidate.id !== room.id).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{roomTitle(candidate)} — opens only when you choose</option>
                ))}
              </optgroup>
              <optgroup label="Planning-only references">
                {ARENA_PLANNING_DESTINATIONS.filter((candidate) => candidate.id !== room.id).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{roomTitle(candidate)} — no executable destination</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Arena project <small>optional reference</small>
            <select value={arenaProjectId} onChange={(event) => setArenaProjectId(event.target.value)} disabled={projectsState === "loading"} data-testid="arena-draft-project">
              <option value="">No Arena project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.emoji ? `${project.emoji} ` : ""}{project.name}</option>)}
            </select>
            {projectsState === "failed" ? <span className="arena-draft-inline-note">Arena projects could not be loaded. You can still save an unlinked local draft.</span> : null}
          </label>
          <label>
            Context to review
            <textarea value={payload} maxLength={8_000} rows={7} onChange={(event) => setPayload(event.target.value)} placeholder="Write only context you are comfortable keeping in this browser." data-testid="arena-draft-payload" />
          </label>
          {error ? <p className="arena-draft-message error" role="alert">{error}</p> : null}
          {message ? <p className="arena-draft-message" role="status">{message}</p> : null}
          <div className="arena-draft-actions">
            <button type="submit" data-testid="arena-draft-save">Save local draft</button>
            <Link href="/handoffs">Open draft ledger →</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export function roomFromId(roomId: string): ArenaRoom | undefined {
  return getArenaRoom(roomId);
}
