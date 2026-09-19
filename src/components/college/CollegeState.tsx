"use client";

import { useCallback, useEffect, useState } from "react";
import TruthBadge, { ClaimRow } from "./TruthBadge";

// The control room. Strictly a PROJECTION of College State — this component
// holds no institutional truth of its own and computes nothing. Everything
// rendered here came from /api/college/state with its provenance attached.

interface Claim {
  value: unknown;
  truthClass: string;
  confidence: string;
  provenance: string;
  conflictWith?: string[];
  note?: string;
}

interface State {
  generatedAt: string;
  realWorld: { date: Claim; longDate: string; time: string; dayLabel: string; timezone: string };
  institution: {
    known: boolean;
    name: string;
    motto: string;
    foundingQuote: string;
    academicYear: number;
    phase: string;
    facultyStatus: Claim;
  };
  position: {
    term: Claim;
    derivedWeek: Claim;
    declaredWeek: Claim;
    effectiveWeek: Claim;
    weekTheme: Claim;
    outOfRange: boolean;
    weeksPastEnd: number;
    weekCount: number;
  };
  scheduled: {
    todaySlots: Array<Record<string, unknown>>;
    nextSlot: Claim;
    weekSlots: Array<Record<string, unknown>>;
    timetableKnown: boolean;
  };
  observed: { currentSession: Claim; recentSessions: Array<Record<string, unknown>>; sessionsThisWeek: number };
  deviations: { open: Array<Record<string, unknown>>; count: number };
  context: { activeSignals: Array<Record<string, unknown>>; count: number };
  goals: { active: Array<Record<string, unknown>>; count: number; stalled: number };
  knowledge: {
    established: Array<Record<string, unknown>>;
    hypotheses: Array<Record<string, unknown>>;
    revisitQueue: Array<Record<string, unknown>>;
    openQuestions: Array<Record<string, unknown>>;
    counts: { observation: number; interpretation: number; hypothesis: number; established: number };
  };
  record: {
    recentFiled: Array<Record<string, unknown>>;
    pendingProposals: Array<Record<string, unknown>>;
    filedCount: number;
    proposedCount: number;
  };
  faculty: { positions: Array<Record<string, unknown>>; count: number };
  curriculum: { courses: Array<Record<string, unknown>>; approvedCount: number; blueprintCount: number };
  attention: { items: Array<{ severity: string; title: string; detail: string; truthClass: string }> };
  conflicts: Array<{ title: string; detail: string; sources: string[] }>;
  unknowns: string[];
  sources: Array<Record<string, unknown>>;
}

function Panel({
  title,
  question,
  children,
  accent = "",
}: {
  title: string;
  question: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur ${accent}`}
    >
      <header className="mb-3">
        <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">{title}</h2>
        <p className="text-[11px] italic text-slate-500">{question}</p>
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[12px] text-slate-500">
      {children}
    </p>
  );
}

export default function CollegeStateView() {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/college/state");
      const data = await res.json();
      if (data.error) setError(data.detail || data.error);
      else setState(data.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount. The async boundary keeps the effect body free of
  // synchronous setState, which React 19 flags as a cascading render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/college/state").catch(() => null);
      if (cancelled) return;
      if (!res) {
        setError("failed to reach College State");
        setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (cancelled) return;
      if (!data || data.error) setError(data?.detail || data?.error || "state unavailable");
      else setState(data.state);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bootstrap = async () => {
    setBooting(true);
    try {
      await fetch("/api/college/bootstrap", { method: "POST" });
      await load();
    } finally {
      setBooting(false);
    }
  };

  if (loading && !state) {
    return <p className="py-20 text-center text-slate-400">Reconstructing institutional state…</p>;
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6">
        <h2 className="font-bold text-rose-200">College State unavailable</h2>
        <p className="mt-1 text-sm text-slate-300">{error}</p>
        <p className="mt-2 text-[12px] text-slate-500">
          The institution does not guess when its records are unreachable.
        </p>
      </div>
    );
  }

  if (!state) return null;

  const s = state;
  const needsBootstrap = !s.institution.known;

  return (
    <div className="space-y-5">
      {/* ---------- header ---------- */}
      <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-950/60 via-[#0a0f22] to-[#060a17] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-300/70">
              Institutional Control Room
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-white">{s.institution.name}</h1>
            <p className="text-sm italic text-slate-400">
              {s.institution.motto} · <span className="text-slate-500">{s.institution.foundingQuote}</span>
            </p>
            {s.institution.phase ? (
              <p className="mt-1 text-[12px] text-slate-500">{s.institution.phase}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                href="/college/curriculum"
                className="inline-block rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 hover:bg-emerald-500/20"
              >
                Manage curriculum →
              </a>
              <a
                href="/college/faculty"
                className="inline-block rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-[12px] font-semibold text-indigo-200 hover:bg-indigo-500/20"
              >
                Faculty attention →
              </a>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-white">{s.realWorld.longDate}</p>
            <p className="text-[12px] text-slate-400">
              {s.realWorld.time} · {s.realWorld.timezone}
            </p>
            <button
              onClick={load}
              className="mt-2 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-200 hover:bg-white/10"
            >
              ↻ Recompute state
            </button>
          </div>
        </div>
        <p className="mt-3 border-t border-white/10 pt-2 text-[11px] text-slate-500">
          State is recomputed from persistent records, never recalled from a model&apos;s conversation
          memory. Generated {new Date(s.generatedAt).toLocaleTimeString()}.
        </p>
      </header>

      {needsBootstrap && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h2 className="font-bold text-amber-100">The College has no institutional record yet</h2>
          <p className="mt-1 text-sm text-slate-300">
            Seed the verified canon (sources, calendar, capabilities, faculty positions). Only
            evidence-backed material is created — nothing is invented.
          </p>
          <button
            onClick={bootstrap}
            disabled={booting}
            className="mt-3 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400 disabled:opacity-50"
          >
            {booting ? "Establishing…" : "Establish institutional state"}
          </button>
        </div>
      )}

      {/* ---------- conflicts: never hidden ---------- */}
      {s.conflicts.length > 0 && (
        <section className="rounded-2xl border border-rose-500/40 bg-rose-500/[0.07] p-5">
          <div className="flex items-center gap-2">
            <TruthBadge truthClass="conflict" />
            <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-rose-100">
              Sources disagree — unresolved by design
            </h2>
          </div>
          <ul className="mt-3 space-y-3">
            {s.conflicts.map((c, i) => (
              <li key={i} className="rounded-lg border border-rose-500/20 bg-black/20 p-3">
                <p className="text-sm font-bold text-rose-100">{c.title}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-300">{c.detail}</p>
                <p className="mt-1.5 text-[11px] text-rose-300/70">{c.sources.join("  vs  ")}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] italic text-slate-400">
            The College will not silently pick a side. Reconciliation is an administrative act.
          </p>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---------- WHERE ARE WE ---------- */}
        <Panel title="Where are we?" question="Academic position, derived from the calendar">
          <div className="space-y-0">
            <ClaimRow label="Term" claim={s.position.term} />
            <ClaimRow label="Week — derived from calendar" claim={s.position.derivedWeek} />
            <ClaimRow label="Week — declared by institution" claim={s.position.declaredWeek} />
            <ClaimRow label="Effective reading" claim={s.position.effectiveWeek} />
            <ClaimRow label="Week theme" claim={s.position.weekTheme} />
          </div>
        </Panel>

        {/* ---------- WHAT SHOULD BE HAPPENING ---------- */}
        <Panel title="What should be happening?" question="Scheduled state — the timetable's intent">
          {s.scheduled.timetableKnown ? (
            <>
              <ClaimRow label="Next scheduled" claim={s.scheduled.nextSlot} />
              <div className="mt-3">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Today</p>
                {s.scheduled.todaySlots.length ? (
                  <ul className="space-y-1">
                    {s.scheduled.todaySlots.map((t, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px]"
                      >
                        <span className="font-semibold text-white">
                          {String(t.startTime || "—")} · {String(t.label)}
                        </span>
                        <TruthBadge
                          truthClass={t.confidence === "known" ? "expectation" : "interpretation"}
                          size="xs"
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing scheduled today.</Empty>
                )}
              </div>
            </>
          ) : (
            <Empty>
              <TruthBadge truthClass="unknown" />
              <span className="mt-2 block">
                No timetable is recorded. The authoritative Semester I day/time mapping was never
                verified, so the College does not claim to know what should be happening.
              </span>
            </Empty>
          )}
        </Panel>

        {/* ---------- WHAT IS ACTUALLY HAPPENING ---------- */}
        <Panel title="What is actually happening?" question="Observed state and real-world conditions">
          <ClaimRow label="Current session" claim={s.observed.currentSession} />
          <div className="mt-3">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              Declared real-world conditions ({s.context.count})
            </p>
            {s.context.activeSignals.length ? (
              <ul className="space-y-1">
                {s.context.activeSignals.slice(0, 5).map((c, i) => (
                  <li key={i} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px]">
                    <span className="font-mono text-[10px] uppercase text-slate-500">
                      {String(c.signalType)}
                    </span>
                    <p className="text-slate-200">{String(c.content)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                None declared. The College reasons from what it is told — it does not infer hidden
                circumstances.
              </Empty>
            )}
          </div>
          {s.deviations.count > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                Scheduled ≠ observed ({s.deviations.count})
              </p>
              <ul className="space-y-1">
                {s.deviations.open.slice(0, 4).map((d, i) => (
                  <li key={i} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[12px]">
                    <p className="text-slate-400">
                      <span className="text-slate-500">scheduled:</span> {String(d.scheduledState)}
                    </p>
                    <p className="text-slate-200">
                      <span className="text-slate-500">observed:</span> {String(d.observedState)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-amber-200/80">
                      {d.adjustedState ? `adjusted: ${String(d.adjustedState)}` : "no adjustment decided"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        {/* ---------- WHAT ARE WE TRYING TO ACCOMPLISH ---------- */}
        <Panel title="What are we trying to accomplish?" question="Active goals — not a productivity score">
          {s.goals.active.length ? (
            <ul className="space-y-2">
              {s.goals.active.slice(0, 6).map((g, i) => (
                <li key={i} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-white">{String(g.title)}</span>
                    <span className="font-mono text-[10px] uppercase text-slate-500">
                      {String(g.status)}
                    </span>
                  </div>
                  {g.purpose ? (
                    <p className="mt-0.5 text-[11px] text-slate-400">{String(g.purpose)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No goals recorded. These are the student&apos;s to declare.</Empty>
          )}
        </Panel>

        {/* ---------- WHAT DOES THE COLLEGE KNOW ---------- */}
        <Panel title="What does the College know?" question="Educational memory, by epistemic status">
          <div className="mb-3 grid grid-cols-4 gap-1.5 text-center">
            {(
              [
                ["observation", "Observed"],
                ["interpretation", "Interpreted"],
                ["hypothesis", "Hypothesis"],
                ["established", "Established"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="rounded-lg border border-white/10 bg-black/20 py-2">
                <p className="text-lg font-black text-white">
                  {s.knowledge.counts[k as keyof typeof s.knowledge.counts]}
                </p>
                <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
              </div>
            ))}
          </div>
          {s.knowledge.established.length || s.knowledge.hypotheses.length ? (
            <ul className="space-y-1">
              {[...s.knowledge.established, ...s.knowledge.hypotheses].slice(0, 5).map((m, i) => (
                <li key={i} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px]">
                  <span className="font-mono text-[9px] uppercase text-slate-500">
                    {String(m.epistemicStatus)} ×{String(m.corroborationCount)}
                  </span>
                  <p className="text-slate-200">{String(m.content).slice(0, 180)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              No teaching knowledge yet. It accumulates from observation and is promoted only with
              corroborating evidence.
            </Empty>
          )}
        </Panel>

        {/* ---------- WHAT NEEDS ATTENTION ---------- */}
        <Panel title="What needs attention?" question="Open loops the institution is carrying">
          {s.attention.items.length ? (
            <ul className="space-y-2">
              {s.attention.items.map((a, i) => (
                <li
                  key={i}
                  className={`rounded-lg border px-3 py-2 ${
                    a.severity === "high"
                      ? "border-rose-500/30 bg-rose-500/5"
                      : "border-white/10 bg-black/20"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-semibold text-white">{a.title}</span>
                    <TruthBadge truthClass={a.truthClass} size="xs" />
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{a.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing outstanding.</Empty>
          )}
        </Panel>
      </div>

      {/* ---------- record + faculty ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Institutional record" question="What has become history — and what has not">
          <div className="mb-3 flex gap-2">
            <div className="flex-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 py-2 text-center">
              <p className="text-lg font-black text-emerald-200">{s.record.filedCount}</p>
              <p className="text-[9px] uppercase tracking-wide text-slate-500">Filed</p>
            </div>
            <div className="flex-1 rounded-lg border border-amber-500/20 bg-amber-500/5 py-2 text-center">
              <p className="text-lg font-black text-amber-200">{s.record.proposedCount}</p>
              <p className="text-[9px] uppercase tracking-wide text-slate-500">Proposed</p>
            </div>
          </div>
          {s.record.pendingProposals.length ? (
            <ul className="space-y-1">
              {s.record.pendingProposals.slice(0, 5).map((r, i) => (
                <li key={i} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px]">
                  <span className="font-mono text-[9px] uppercase text-slate-500">
                    {String(r.recordType)}
                  </span>
                  <p className="text-slate-200">{String(r.subject)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing awaiting filing.</Empty>
          )}
          <p className="mt-2 text-[11px] italic text-slate-500">
            The Registrar proposes. Filing is a separate institutional act — working conversation
            never becomes history on its own.
          </p>
        </Panel>

        <Panel title="Who should be involved?" question="Faculty positions and their authority">
          <ul className="space-y-1">
            {s.faculty.positions.map((f, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-white">{String(f.name)}</p>
                  <p className="truncate text-[11px] text-slate-500">{String(f.remit).slice(0, 78)}</p>
                </div>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                    f.derivation === "canon-derived"
                      ? "border-emerald-500/30 text-emerald-300"
                      : f.derivation === "inferred"
                        ? "border-sky-500/30 text-sky-300"
                        : "border-slate-500/30 text-slate-400"
                  }`}
                >
                  {String(f.derivation)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* ---------- unknowns ---------- */}
      {s.unknowns.length > 0 && (
        <section className="rounded-2xl border border-slate-500/30 bg-slate-500/5 p-5">
          <div className="flex items-center gap-2">
            <TruthBadge truthClass="unknown" />
            <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-slate-200">
              What the College does not know
            </h2>
          </div>
          <ul className="mt-2 space-y-1">
            {s.unknowns.map((u, i) => (
              <li key={i} className="text-[12px] text-slate-400">
                · {u}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] italic text-slate-500">
            Uncertainty is a legitimate scholarly outcome, not a gap to paper over.
          </p>
        </section>
      )}

      {/* ---------- sources ---------- */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">
          Source authority
        </h2>
        <p className="mb-3 text-[11px] italic text-slate-500">
          Canon lives in Notion. Arena references it and never mutates it.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {s.sources.map((src, i) => (
            <a
              key={i}
              href={String(src.url) || undefined}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 transition hover:border-white/25"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-slate-200">
                  {String(src.title)}
                </span>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                    src.canonicalStatus === "canonical"
                      ? "border-emerald-500/40 text-emerald-300"
                      : src.canonicalStatus === "validated"
                        ? "border-sky-500/40 text-sky-300"
                        : src.canonicalStatus === "draft"
                          ? "border-amber-500/40 text-amber-300"
                          : "border-slate-500/40 text-slate-400"
                  }`}
                >
                  {String(src.canonicalStatus)}
                </span>
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
