"use client";

// Congress — multiple AI collaborators sit together for a set amount of time
// and produce durable results: live deliberation on the floor, an Act
// (resolution document) drafted by the Clerk when the clock runs out, saved
// to the artifact library, and reconvenable sittings that compound.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";
import { CHAMBER_PRESETS, CONGRESS_ROLES, getCongressRole } from "@/lib/congressRoles";

interface Seat {
  label?: string;
  role: string;
  modelId: string;
}

interface Turn {
  id: string;
  seatIndex: number;
  role: string;
  label: string;
  modelId: string;
  content: string;
  kind: string;
  createdAt: string;
}

interface Session {
  id: string;
  title: string;
  topic: string;
  projectId: string | null;
  status: "sitting" | "adjourned" | "closed";
  seats: Seat[];
  synthesisModel: string;
  durationMs: number;
  remainingMs: number | null;
  endsAt: string | null;
  turnCount: number;
  maxTurns: number;
  act: string | null;
  parentSessionId: string | null;
  sitting: number;
  createdAt: string;
  turns: Turn[];
  msRemaining: number;
}

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
}

interface ProjectInfo {
  id: string;
  name: string;
  emoji: string;
}

const DURATIONS = [
  { minutes: 3, label: "⚡ 3 min" },
  { minutes: 5, label: "🪑 5 min" },
  { minutes: 10, label: "🏛️ 10 min" },
  { minutes: 20, label: "📜 20 min" },
  { minutes: 30, label: "🌐 30 min" },
];

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function seatLabel(seat: Seat, i: number): { emoji: string; label: string } {
  const role = getCongressRole(seat.role);
  return { emoji: seat.label ? role.emoji : role.emoji, label: seat.label || `${role.label} ${i + 1}` };
}

export default function CongressChamber() {
  // ---- catalog data ----
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [record, setRecord] = useState<Session[]>([]);

  // ---- setup form ----
  const [topic, setTopic] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [seats, setSeats] = useState<Seat[]>([
    { role: "chair", modelId: "openai" },
    { role: "proposer", modelId: "mistral" },
    { role: "skeptic", modelId: "deepseek" },
  ]);
  const [synthesisModel, setSynthesisModel] = useState("openai");
  const [projectId, setProjectId] = useState("");
  const [convening, setConvening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- live session ----
  const [session, setSession] = useState<Session | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const advanceInFlight = useRef(false);
  const floorRef = useRef<HTMLDivElement | null>(null);

  const textModels = useMemo(() => models.filter((m) => m.kind === "text"), [models]);

  // ---- data loading ----
  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      try {
        const res = await fetch("/api/models");
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      } catch {
        /* offline */
      }
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        if (Array.isArray(data.projects)) setProjects(data.projects);
      } catch {
        /* offline */
      }
    })();
  }, []);

  const refreshRecord = useCallback(async () => {
    try {
      const res = await fetch("/api/congress?limit=30");
      const data = await res.json();
      if (Array.isArray(data.sessions)) setRecord(data.sessions);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await refreshRecord();
    })();
  }, [refreshRecord]);

  // ---- advance loop (client-driven: one step per call, bounded server work) ----
  const advance = useCallback(async () => {
    if (advanceInFlight.current) return;
    advanceInFlight.current = true;
    setAdvancing(true);
    try {
      const res = await fetch(`/api/congress/${session!.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (data?.state) {
        setSession(data.state);
        if (data.done) void refreshRecord();
      }
    } catch {
      /* transient — next tick retries */
    } finally {
      advanceInFlight.current = false;
      setAdvancing(false);
    }
  }, [refreshRecord, session]);

  useEffect(() => {
    if (!session || session.status !== "sitting") return;
    const iv = setInterval(() => void advance(), 3000);
    return () => clearInterval(iv);
  }, [advance, session]);

  // local countdown between server fetches (state, not derived-at-render,
  // so the component stays pure; the server value seeds it on every advance)
  const [msRemaining, setMsRemaining] = useState(0);
  useEffect(() => {
    setMsRemaining(session?.msRemaining ?? 0);
  }, [session?.id, session?.msRemaining, session?.status]);
  useEffect(() => {
    if (!session || session.status !== "sitting") return;
    const iv = setInterval(() => {
      setMsRemaining((prev) => Math.max(0, prev - 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [session]);

  // autoscroll the floor
  useEffect(() => {
    floorRef.current?.scrollTo({ top: floorRef.current.scrollHeight, behavior: "smooth" });
  }, [session?.turns.length]);

  // ---- actions ----
  const convene = async () => {
    if (!topic.trim()) {
      setError("State what the congress should deliberate");
      return;
    }
    setConvening(true);
    setError(null);
    try {
      const res = await fetch("/api/congress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          seats,
          durationMinutes,
          synthesisModel,
          projectId: projectId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "convene failed");
      setSession(data.session);
      void refreshRecord();
    } catch (e) {
      setError(e instanceof Error ? e.message : "convene failed");
    } finally {
      setConvening(false);
    }
  };

  const lifecycle = async (action: "adjourn" | "resume" | "close") => {
    if (!session) return;
    setBusyAction(action);
    try {
      const res = await fetch(`/api/congress/${session.id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (data?.session) setSession(data.session);
      void refreshRecord();
    } catch {
      /* ignore */
    } finally {
      setBusyAction(null);
    }
  };

  const reconvene = async (id: string) => {
    const src = record.find((r) => r.id === id) ?? session;
    if (!src) return;
    setBusyAction("reconvene");
    setError(null);
    try {
      const res = await fetch("/api/congress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reconveneOf: src.id,
          topic: src.topic,
          seats: src.seats,
          durationMinutes: Math.round(src.durationMs / 60000),
          synthesisModel: src.synthesisModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "reconvene failed");
      setSession(data.session);
      void refreshRecord();
    } catch (e) {
      setError(e instanceof Error ? e.message : "reconvene failed");
    } finally {
      setBusyAction(null);
    }
  };

  const openSession = async (id: string) => {
    try {
      const res = await fetch(`/api/congress/${id}`);
      const data = await res.json();
      if (data?.session) setSession(data.session);
    } catch {
      /* ignore */
    }
  };

  const deleteSession = async (id: string) => {
    try {
      await fetch(`/api/congress/${id}`, { method: "DELETE" });
      if (session?.id === id) setSession(null);
      void refreshRecord();
    } catch {
      /* ignore */
    }
  };

  const applyPreset = (presetId: string) => {
    const preset = CHAMBER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setDurationMinutes(preset.minutes);
    const pool = textModels.filter((m) => m.id !== "offline-sage");
    setSeats(
      preset.seats.map((role, i) => ({
        role,
        modelId: i === 0 ? "openai" : pool[i % Math.max(1, pool.length)]?.id ?? "openai",
      }))
    );
  };

  // ---- render helpers ----
  const statusPill = (s: Session) => (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${
        s.status === "sitting"
          ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
          : s.status === "adjourned"
            ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
            : "bg-white/5 text-slate-400 ring-white/10"
      }`}
    >
      {s.status === "sitting" ? "🟢 sitting" : s.status === "adjourned" ? "⏸ adjourned" : "📁 closed"}
    </span>
  );

  // ================= render =================

  return (
    <div className="mx-auto max-w-7xl">
      {/* header */}
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-xs font-bold text-amber-200">
          🏛️ Congress · many minds, one clock, durable acts
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
          Seat a congress,{" "}
          <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">
            let it deliberate
          </span>
        </h1>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-300">
          Multiple AI collaborators with distinct roles sit together for a set amount of time. When the clock runs
          out, the Clerk drafts the <strong className="text-slate-100">Act</strong> — a resolution document saved to
          your artifacts. Adjourn, resume, and reconvene later to build on it.
        </p>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* ---- left: setup / info + record ---- */}
        <div className="space-y-4">
          {!session ? (
            <div className="glass rounded-2xl p-4">
              <h2 className="text-sm font-extrabold text-white">⚖️ Convene</h2>

              <label className="mt-3 block">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Topic</span>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  rows={3}
                  placeholder="What should this congress settle? e.g. 'Design the offline-first sync strategy for my field-notes app'"
                  className="scroll-thin mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400/60"
                />
              </label>

              <div className="mt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Chamber preset</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {CHAMBER_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => applyPreset(p.id)}
                      title={`${p.seats.length} seats · ${p.minutes} min`}
                      className="rounded-xl bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10"
                    >
                      {p.emoji} {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Sitting length</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {DURATIONS.map((d) => (
                    <button
                      key={d.minutes}
                      onClick={() => setDurationMinutes(d.minutes)}
                      className={`rounded-xl px-2.5 py-1.5 text-xs font-bold ring-1 transition ${
                        durationMinutes === d.minutes
                          ? "bg-amber-400/15 text-amber-100 ring-amber-400/40"
                          : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* seats */}
              <div className="mt-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Seats ({seats.length})
                  </span>
                  <button
                    onClick={() => seats.length < 8 && setSeats([...seats, { role: "researcher", modelId: "openai" }])}
                    className="rounded-lg bg-white/5 px-2 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                  >
                    + seat
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {seats.map((seat, i) => {
                    const meta = seatLabel(seat, i);
                    return (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="w-6 text-center text-sm">{meta.emoji}</span>
                        <select
                          value={seat.role}
                          onChange={(e) => {
                            const next = [...seats];
                            next[i] = { ...seat, role: e.target.value, label: undefined };
                            setSeats(next);
                          }}
                          className="w-28 rounded-lg border border-white/10 bg-black/40 px-1.5 py-1.5 text-xs text-white outline-none"
                        >
                          {CONGRESS_ROLES.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={seat.modelId}
                          onChange={(e) => {
                            const next = [...seats];
                            next[i] = { ...seat, modelId: e.target.value };
                            setSeats(next);
                          }}
                          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-1.5 py-1.5 text-xs text-white outline-none"
                        >
                          {textModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.emoji} {m.name}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => seats.length > 2 && setSeats(seats.filter((_, j) => j !== i))}
                          className="rounded-lg bg-red-500/10 px-1.5 py-1 text-xs text-red-300 ring-1 ring-red-400/20 hover:bg-red-500/20"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <label className="mt-3 block">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Clerk (drafts the Act)</span>
                <select
                  value={synthesisModel}
                  onChange={(e) => setSynthesisModel(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none"
                >
                  {textModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.emoji} {m.name}
                    </option>
                  ))}
                </select>
              </label>

              {projects.length > 0 && (
                <label className="mt-3 block">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Link to project (optional)
                  </span>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none"
                  >
                    <option value="">— none —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.emoji} {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <button
                onClick={convene}
                disabled={convening}
                className="mt-4 w-full rounded-2xl bg-gradient-to-r from-amber-500 to-emerald-500 px-4 py-3 text-base font-black text-white shadow-xl shadow-amber-900/30 transition hover:brightness-110 disabled:opacity-40"
              >
                {convening ? "Gaveling in…" : "🔨 Convene the congress"}
              </button>
              {error && (
                <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 ring-1 ring-red-400/30">
                  {error}
                </p>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                The chamber deliberates while this page is open (one turn every few seconds). Close the tab and the
                record is safe — reopen later and the clock resumes where it stood.
              </p>
            </div>
          ) : (
            <div className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-extrabold text-white">🏛️ {session.title}</h2>
                {statusPill(session)}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{session.topic}</p>
              <div className="mt-3 space-y-1 text-[11px] text-slate-500">
                <p>
                  Sitting #{session.sitting} · {session.turnCount}/{session.maxTurns} turns used
                  {session.parentSessionId ? " · reconvened" : ""}
                </p>
                {session.projectId && <p>📁 linked to a project — the Act lands in its artifacts & memory</p>}
              </div>
              <div className="mt-3 space-y-1.5">
                {session.seats.map((seat, i) => {
                  const meta = seatLabel(seat, i);
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs text-slate-300">
                      <span>{meta.emoji}</span>
                      <span className="font-bold">{meta.label}</span>
                      <span className="truncate text-slate-500">
                        · {models.find((m) => m.id === seat.modelId)?.name ?? seat.modelId}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {session.status === "sitting" && (
                  <>
                    <button
                      onClick={() => lifecycle("adjourn")}
                      disabled={!!busyAction}
                      className="rounded-xl bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/25 disabled:opacity-40"
                    >
                      ⏸ Adjourn
                    </button>
                    <button
                      onClick={() => lifecycle("close")}
                      disabled={!!busyAction}
                      className="rounded-xl bg-red-500/15 px-3 py-1.5 text-xs font-bold text-red-200 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-40"
                    >
                      📜 Close & draft Act
                    </button>
                  </>
                )}
                {session.status === "adjourned" && (
                  <button
                    onClick={() => lifecycle("resume")}
                    disabled={!!busyAction}
                    className="rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25 disabled:opacity-40"
                  >
                    ▶ Resume the clock
                  </button>
                )}
                {session.status === "closed" && (
                  <button
                    onClick={() => reconvene(session.id)}
                    disabled={!!busyAction}
                    className="rounded-xl bg-violet-500/15 px-3 py-1.5 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25 disabled:opacity-40"
                  >
                    🏛️ Reconvene (new sitting)
                  </button>
                )}
                <button
                  onClick={() => setSession(null)}
                  className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                >
                  ← New congress
                </button>
              </div>
            </div>
          )}

          {/* the record */}
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-white">📚 The record</h2>
              <button
                onClick={() => void refreshRecord()}
                className="rounded-lg bg-white/5 px-2 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                ↻
              </button>
            </div>
            {record.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No congresses yet. Convene one →</p>
            ) : (
              <div className="scroll-thin mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {record.map((r) => (
                  <div key={r.id} className="flex items-center gap-1.5">
                    <button
                      onClick={() => void openSession(r.id)}
                      className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left ring-1 transition ${
                        session?.id === r.id
                          ? "bg-amber-400/15 ring-amber-400/40"
                          : "bg-white/[0.03] ring-white/5 hover:bg-white/[0.07]"
                      }`}
                    >
                      <p className="truncate text-xs font-bold text-white">
                        {r.sitting > 1 ? `#${r.sitting} ` : ""}
                        {r.title}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                        {statusPill(r)} · {r.turnCount} turns
                      </p>
                    </button>
                    <button
                      onClick={() => void deleteSession(r.id)}
                      className="rounded-lg bg-red-500/10 px-1.5 py-1.5 text-xs text-red-300 ring-1 ring-red-400/20 hover:bg-red-500/20"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---- right: the floor ---- */}
        <div className="glass flex min-h-[560px] flex-col rounded-2xl p-4">
          {!session ? (
            <div className="grid flex-1 place-items-center text-center">
              <div>
                <p className="text-4xl">🏛️</p>
                <p className="mt-3 text-sm font-bold text-slate-300">The floor is empty</p>
                <p className="mt-1 max-w-sm text-xs text-slate-500">
                  Convene a congress and the chamber appears here — live deliberation, countdown, and the Act when
                  the gavel falls.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* floor header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  {statusPill(session)}
                  {session.status === "sitting" && (
                    <span className="font-mono text-lg font-black tabular-nums text-amber-300">
                      ⏳ {fmtCountdown(msRemaining)}
                    </span>
                  )}
                  {session.status === "adjourned" && session.remainingMs !== null && (
                    <span className="font-mono text-sm text-amber-300/70">
                      {fmtCountdown(session.remainingMs)} paused
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">
                  {advancing ? "the floor is speaking…" : session.status === "closed" ? "sitting closed" : "deliberating"}
                </span>
              </div>

              {/* transcript */}
              <div ref={floorRef} className="scroll-thin mt-3 max-h-[540px] flex-1 space-y-3 overflow-y-auto pr-1">
                {session.turns.length === 0 && (
                  <p className="pt-8 text-center text-xs text-slate-500">The chair is clearing its throat…</p>
                )}
                {session.turns.map((turn) => {
                  if (turn.kind === "system") {
                    return (
                      <p
                        key={turn.id}
                        className="mx-auto w-fit rounded-full bg-white/5 px-3 py-1 text-center text-[11px] font-medium text-slate-400 ring-1 ring-white/10"
                      >
                        {turn.content.slice(0, 200)}
                      </p>
                    );
                  }
                  if (turn.kind === "act") {
                    return (
                      <div key={turn.id} className="rounded-2xl bg-amber-400/[0.06] p-4 ring-1 ring-amber-400/25">
                        <p className="text-xs font-black uppercase tracking-wider text-amber-300">
                          📜 The Act of the Congress
                        </p>
                        <div className="mt-2">
                          <Markdown text={turn.content} />
                        </div>
                      </div>
                    );
                  }
                  const seat = session.seats[turn.seatIndex] ?? { role: turn.role, modelId: turn.modelId };
                  const meta = seatLabel(seat, turn.seatIndex);
                  return (
                    <div key={turn.id} className="flex gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/5 text-base ring-1 ring-white/10">
                        {meta.emoji}
                      </span>
                      <div className="min-w-0 flex-1 rounded-2xl bg-white/[0.03] px-3.5 py-2.5 ring-1 ring-white/5">
                        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <span className="font-extrabold text-white">{turn.label || meta.label}</span>
                          <span className="text-[10px] text-slate-500">
                            {models.find((m) => m.id === turn.modelId)?.name ?? turn.modelId}
                          </span>
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
                          {turn.content}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {session.status === "sitting" && (
                  <div className="flex items-center gap-2 px-2 pt-1 text-[11px] text-slate-500">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    next speaker taking the floor…
                  </div>
                )}
              </div>

              {/* closed summary strip */}
              {session.status === "closed" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                  <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                    📦 Act saved to artifacts{session.projectId ? " & project memory" : ""}
                  </span>
                  <button
                    onClick={() => reconvene(session.id)}
                    disabled={!!busyAction}
                    className="rounded-xl bg-violet-500/15 px-3 py-1.5 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25 disabled:opacity-40"
                  >
                    🏛️ Reconvene — build on this Act
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
