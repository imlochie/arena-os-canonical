"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  Info,
  Link2Off,
  LockKeyhole,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import {
  ARENA_ROOMS,
  ARENA_ROOM_STATE_LABELS,
  type ArenaRoom,
} from "@/lib/arenaRooms";
import {
  readArenaHandoffs,
  writeArenaHandoffs,
  type ArenaHandoff,
} from "@/lib/arenaHandoffs";

type ProjectOption = {
  id: string;
  name: string;
  description?: string | null;
};

function makeHandoffId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ArenaRoomDetail({ room }: { room: ArenaRoom }) {
  const [title, setTitle] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [payload, setPayload] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadProjects() {
      setProjectsLoading(true);
      setProjectError(null);
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        if (!response.ok) throw new Error("Projects could not be loaded.");
        const body = (await response.json()) as { projects?: ProjectOption[] };
        if (!Array.isArray(body.projects)) throw new Error("Projects could not be loaded.");
        if (active) setProjects(body.projects);
      } catch {
        if (active) setProjectError("Projects could not be loaded. You can still save without a project.");
      } finally {
        if (active) setProjectsLoading(false);
      }
    }

    loadProjects();
    return () => {
      active = false;
    };
  }, []);

  function submitHandoff() {
    setSaved(false);
    setFormError(null);
    setStorageError(null);

    const cleanTitle = title.trim();
    const cleanPayload = payload.trim();
    if (!cleanTitle) {
      setFormError("Add a title so this handoff is easy to recognize.");
      return;
    }
    if (!destinationId || destinationId === room.id) {
      setFormError("Choose a destination room that is different from the source.");
      return;
    }
    if (!cleanPayload) {
      setFormError("Add a nonempty payload before saving the handoff.");
      return;
    }

    const current = readArenaHandoffs();
    if (!current.ok) {
      setStorageError(current.error);
      return;
    }

    const record: ArenaHandoff = {
      id: makeHandoffId(),
      title: cleanTitle,
      fromRoomId: room.id,
      toRoomId: destinationId,
      projectId: projectId || null,
      payload: cleanPayload,
      createdAt: new Date().toISOString(),
      status: "queued",
    };

    const result = writeArenaHandoffs([record, ...current.records]);
    if (!result.ok) {
      setStorageError(result.error);
      return;
    }

    setTitle("");
    setDestinationId("");
    setProjectId("");
    setPayload("");
    setSaved(true);
  }

  const stateLabel = ARENA_ROOM_STATE_LABELS[room.state];

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12" data-testid="arena-room-detail">
      <Link
        href="/rooms"
        className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 transition hover:text-white"
        data-testid="room-detail-back"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        All rooms
      </Link>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="glass overflow-hidden rounded-[26px] p-6 sm:p-9">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-100">
              {room.eyebrow} room
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">
              {stateLabel}
            </span>
          </div>
          <h1 className="mt-5 text-4xl font-black tracking-[-0.05em] text-white sm:text-6xl">
            {room.name}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300">
            {room.description}
          </p>

          {room.destination ? (
            <div className="mt-8 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-200" size={18} aria-hidden="true" />
                <div>
                  <p className="text-sm font-bold text-emerald-100">Existing app surface</p>
                  <p className="mt-1 text-sm leading-5 text-slate-400">
                    This room points to the existing app surface below. Nothing begins until
                    you choose to submit there.
                  </p>
                  <Link
                    href={room.destination.href}
                    className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-cyan-200 hover:text-white"
                    data-testid="room-existing-destination"
                  >
                    {room.destination.label}
                    <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                  {room.secondaryDestination ? (
                    <Link
                      href={room.secondaryDestination.href}
                      className="ml-4 inline-flex items-center gap-2 text-sm font-bold text-slate-300 hover:text-white"
                      data-testid="room-secondary-destination"
                    >
                      {room.secondaryDestination.label}
                      <ExternalLink size={14} aria-hidden="true" />
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-8 rounded-2xl border border-slate-300/15 bg-slate-300/[0.05] p-4">
              <div className="flex items-start gap-3">
                <Link2Off className="mt-0.5 shrink-0 text-slate-300" size={18} aria-hidden="true" />
                <div>
                  <p className="text-sm font-bold text-slate-200">No service connected</p>
                  <p className="mt-1 text-sm leading-5 text-slate-400">
                    This is an address and handoff surface only. No model, media job, upload,
                    export, or background service runs from this room.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 grid gap-3 border-t border-white/10 pt-6 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-black/10 p-3">
              <ClipboardList size={16} className="text-violet-200" aria-hidden="true" />
              <p className="mt-2 text-xs font-bold text-white">Metadata first</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Handoffs stay in this browser.</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/10 p-3">
              <LockKeyhole size={16} className="text-amber-200" aria-hidden="true" />
              <p className="mt-2 text-xs font-bold text-white">Your decision</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Nothing transfers by itself.</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/10 p-3">
              <Sparkles size={16} className="text-cyan-200" aria-hidden="true" />
              <p className="mt-2 text-xs font-bold text-white">Visible queue</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Review before the next step.</p>
            </div>
          </div>
        </div>

        <div className="glass h-fit rounded-[26px] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-violet-200/70">
                New handoff
              </p>
              <h2 className="mt-2 text-xl font-extrabold tracking-tight text-white">
                Prepare a transfer
              </h2>
            </div>
            <Send size={19} className="text-cyan-200" aria-hidden="true" />
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Save metadata for a deliberate next step. The payload is not sent to the destination.
          </p>

          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold text-slate-300">Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-violet-400/60 focus:ring-2 focus:ring-violet-400/10"
                placeholder="A short name for this handoff"
                data-testid="handoff-title"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-300">Source room</span>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3.5 py-3 text-sm text-slate-300">
                  <ArrowRight size={14} className="text-violet-200" aria-hidden="true" />
                  <span>{room.name}</span>
                </div>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-300">Destination room</span>
                <select
                  value={destinationId}
                  onChange={(event) => setDestinationId(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-[#0c1428] px-3.5 py-3 text-sm text-white outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/10"
                  data-testid="handoff-destination"
                >
                  <option value="">Choose a room</option>
                  {ARENA_ROOMS.filter((candidate) => candidate.id !== room.id).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-300">
                Project
                <span className="font-normal text-slate-500">optional</span>
              </span>
              {projectsLoading ? (
                <div className="h-11 animate-pulse rounded-xl border border-white/10 bg-white/5" data-testid="projects-loading" />
              ) : (
                <select
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-[#0c1428] px-3.5 py-3 text-sm text-white outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/10"
                  data-testid="handoff-project"
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
              {projectError ? (
                <span className="mt-1.5 block text-xs leading-5 text-amber-200/80" data-testid="project-load-error">
                  {projectError}
                </span>
              ) : !projectsLoading && projects.length === 0 ? (
                <span className="mt-1.5 block text-xs leading-5 text-slate-500" data-testid="projects-empty">
                  No projects available. This handoff can remain unlinked.
                </span>
              ) : null}
            </label>

            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-300">
                Payload
                <Info size={13} className="text-slate-500" aria-hidden="true" />
              </span>
              <textarea
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                rows={7}
                className="w-full resize-y rounded-xl border border-white/10 bg-black/25 px-3.5 py-3 text-sm leading-5 text-white outline-none transition placeholder:text-slate-600 focus:border-violet-400/60 focus:ring-2 focus:ring-violet-400/10"
                placeholder="Write the context you want to make visible to the next room"
                data-testid="handoff-payload"
              />
            </label>
          </div>

          {formError ? (
            <div className="mt-4 flex gap-2 rounded-xl border border-rose-300/20 bg-rose-300/[0.07] p-3 text-xs leading-5 text-rose-100" role="alert" data-testid="handoff-form-error">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{formError}</span>
            </div>
          ) : null}
          {storageError ? (
            <div className="mt-4 flex gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-3 text-xs leading-5 text-amber-100" role="alert" data-testid="handoff-storage-error">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{storageError}</span>
            </div>
          ) : null}
          {saved ? (
            <div className="mt-4 flex gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.07] p-3 text-xs leading-5 text-emerald-100" role="status" data-testid="handoff-save-status">
              <Check size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>Handoff saved to this browser. Review it from the ledger.</span>
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={submitHandoff}
              className="btn-arena inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-extrabold text-white"
              data-testid="handoff-submit"
            >
              Save handoff
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <Link
              href="/handoffs"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-slate-200 transition hover:bg-white/10 hover:text-white"
              data-testid="room-ledger-link"
            >
              Open ledger
              <FileText size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}