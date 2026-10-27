"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * THE RUNTIME INSPECTOR
 *
 * One question, answered completely: what did the College know at this exact
 * moment, and why did it act the way it did?
 *
 * This is a reconstruction, never a re-execution. Nothing on this page can
 * change a record — that is the point of it.
 */

interface SessionRow {
  id: string;
  title: string;
  observedDate: string | null;
  status: string;
  stage: string;
  sessionKind: string;
  summary: string;
}

interface Inspection {
  session: { id: string; title: string; status: string; stage: string; objective: string; observedDate: string | null; summary: string };
  pinned: {
    curriculumVersion: { label: string; versionNumber: number } | null;
    courseSnapshot: { code: string; title: string; capturedAt: string } | null;
    course: { code: string; title: string; currentStatus: string } | null;
    courseHasChangedSince: boolean;
    divergence: string[];
  };
  faculty: Array<{
    positionKey: string;
    memberName: string;
    participation: string;
    versionAtTime: number | null;
    currentVersion: number | null;
    configurationHasChangedSince: boolean;
    configurationAtTime: Record<string, unknown> | null;
  }>;
  attention: Array<{
    eventType: string;
    positionKey: string;
    memberName: string;
    resolvedState: string;
    action: string;
    decidedBy: string;
    reason: string;
  }>;
  contributions: Array<{
    positionKey: string;
    contributionType: string;
    stance: string;
    truthClass: string;
    confidence: string;
    content: string;
  }>;
  coordination: {
    consultations: Array<{ from: string; to: string; reason: string; question: string; response: string; status: string }>;
    handoffs: Array<{ from: string; to: string; reason: string; disposition: string }>;
    phases: Array<{ phaseKey: string; primary: string[]; watching: string[]; note: string }>;
  };
  ledger: Array<{ time: string; sequence: number; eventType: string; summary: string; positionKey: string }>;
  events: Array<{ sequence: number; eventType: string; emittedBy: string; payload: string }>;
  memoryAtTime: Array<{ positionKey: string; content: string; observationCount: number; promotionStatus: string; existedBefore: boolean }>;
  trail: Array<{ stage: string; note: string; actor: string }>;
  note: string;
}

const ACTION_COLOR: Record<string, string> = {
  ignore: "#475569",
  notice: "#64748b",
  activate: "#a855f7",
  consult: "#06b6d4",
  defer: "#f59e0b",
  escalate: "#ef4444",
  speak: "#22c55e",
};

const TABS = ["attention", "context", "coordination", "events", "memory", "output"] as const;
type Tab = (typeof TABS)[number];

export default function InspectorPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [tab, setTab] = useState<Tab>("attention");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/college/inspector");
        const d = await r.json();
        if (cancelled) return;
        setSessions(d.sessions ?? []);
        if ((d.sessions ?? []).length) setSelected(d.sessions[0].id);
      } catch {
        if (!cancelled) setSessions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/college/inspector?sessionId=${selected}`);
        const d = await r.json();
        if (!cancelled) setInspection(d.inspection ?? null);
      } catch {
        if (!cancelled) setInspection(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-8 text-slate-200">
      <div className="mx-auto max-w-[1400px]">
        <header className="mb-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">Runtime Inspector</h1>
            <Link href="/college" className="text-[12px] text-slate-500 hover:text-slate-300">
              ← College
            </Link>
            <Link href="/college/day" className="text-[12px] text-slate-500 hover:text-slate-300">
              Today
            </Link>
            <Link href="/college/governance" className="text-[12px] text-slate-500 hover:text-slate-300">
              Governance
            </Link>
          </div>
          <p className="mt-1 text-[13px] text-slate-500">
            What did the College know at this exact moment, and why did it act the way it did? This
            is a reconstruction — nothing here re-runs a class or changes a record.
          </p>
        </header>

        <div className="grid grid-cols-[280px_1fr] gap-5">
          {/* ---- SESSION LIST ---- */}
          <aside className="rounded-xl border border-slate-800 bg-[#0d0d14] p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Sessions
            </div>
            {loading ? (
              <div className="text-[12px] text-slate-600">Loading…</div>
            ) : !sessions.length ? (
              <div className="text-[12px] text-slate-600">No sessions recorded yet.</div>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition ${
                      selected === s.id
                        ? "bg-blue-500/15 ring-1 ring-blue-500/40"
                        : "hover:bg-slate-800/40"
                    }`}
                  >
                    <div className="truncate text-[12px] font-medium text-slate-200">{s.title}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span>{s.observedDate ?? "—"}</span>
                      <span
                        className={
                          s.status === "completed"
                            ? "text-emerald-500"
                            : s.status === "running"
                              ? "text-amber-500"
                              : "text-slate-600"
                        }
                      >
                        {s.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </aside>

          {/* ---- INSPECTION ---- */}
          <main>
            {!inspection ? (
              <div className="rounded-xl border border-slate-800 bg-[#0d0d14] p-8 text-center text-[13px] text-slate-600">
                {selected ? "Reconstructing…" : "Select a session."}
              </div>
            ) : (
              <>
                {/* PINNED CONTEXT */}
                <section className="mb-4 rounded-xl border border-slate-800 bg-[#0d0d14] p-4">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    What was pinned when this ran
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-[12px]">
                    <Field label="Session" value={inspection.session.title} />
                    <Field
                      label="Curriculum version"
                      value={inspection.pinned.curriculumVersion?.label ?? "(none)"}
                    />
                    <Field
                      label="Course (as it was)"
                      value={
                        inspection.pinned.courseSnapshot
                          ? `${inspection.pinned.courseSnapshot.code} — ${inspection.pinned.courseSnapshot.title}`
                          : "(not snapshotted)"
                      }
                    />
                    <Field label="Status" value={inspection.session.status} />
                  </div>
                  {inspection.pinned.divergence.length > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                        The College has changed since
                      </div>
                      {inspection.pinned.divergence.map((d, i) => (
                        <div key={i} className="mt-1 text-[12px] text-amber-200/90">
                          {d}
                        </div>
                      ))}
                    </div>
                  )}
                  {inspection.session.objective && (
                    <div className="mt-3 text-[12px] text-slate-400">
                      <span className="text-slate-600">Objective: </span>
                      {inspection.session.objective}
                    </div>
                  )}
                </section>

                {/* TABS */}
                <div className="mb-3 flex gap-1">
                  {TABS.map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition ${
                        tab === t
                          ? "bg-slate-700 text-white"
                          : "text-slate-500 hover:bg-slate-800/50 hover:text-slate-300"
                      }`}
                    >
                      {t}
                      {t === "attention" && ` (${inspection.attention.length})`}
                      {t === "events" && ` (${inspection.ledger.length})`}
                      {t === "memory" && ` (${inspection.memoryAtTime.length})`}
                      {t === "output" && ` (${inspection.contributions.length})`}
                    </button>
                  ))}
                </div>

                <section className="rounded-xl border border-slate-800 bg-[#0d0d14] p-4">
                  {tab === "attention" && (
                    <div className="space-y-1">
                      {!inspection.attention.length ? (
                        <Empty>No attention decisions were recorded for this session.</Empty>
                      ) : (
                        inspection.attention.map((a, i) => (
                          <div
                            key={i}
                            className="grid grid-cols-[150px_110px_90px_1fr] items-start gap-3 rounded-lg px-2 py-1.5 text-[12px] odd:bg-slate-900/30"
                          >
                            <span className="font-mono text-[11px] text-slate-500">
                              {a.eventType}
                            </span>
                            <span className="text-slate-300">{a.memberName || a.positionKey}</span>
                            <span
                              className="font-semibold"
                              style={{ color: ACTION_COLOR[a.action] ?? "#94a3b8" }}
                            >
                              {a.resolvedState}
                            </span>
                            <span className="text-slate-500">
                              {a.reason}
                              <span className="ml-1.5 rounded bg-slate-800 px-1 py-px text-[9px] uppercase tracking-wider text-slate-400">
                                by {a.decidedBy}
                              </span>
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {tab === "context" && (
                    <div className="space-y-2">
                      {inspection.faculty.map((f, i) => (
                        <div key={i} className="rounded-lg border border-slate-800 p-3">
                          <div className="flex items-baseline justify-between">
                            <div className="text-[13px] font-semibold text-slate-200">
                              {f.memberName}{" "}
                              <span className="text-[11px] font-normal text-slate-500">
                                {f.positionKey} · {f.participation}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500">
                              served at v{f.versionAtTime ?? "?"}
                              {f.configurationHasChangedSince && (
                                <span className="ml-2 text-amber-400">
                                  now v{f.currentVersion} — configuration changed since
                                </span>
                              )}
                            </div>
                          </div>
                          {f.configurationAtTime && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300">
                                configuration in force at the time
                              </summary>
                              <pre className="mt-1.5 max-h-52 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-relaxed text-slate-400">
                                {JSON.stringify(f.configurationAtTime, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                      {!inspection.faculty.length && (
                        <Empty>No faculty members were recorded against this session.</Empty>
                      )}
                    </div>
                  )}

                  {tab === "coordination" && (
                    <div className="space-y-3">
                      <Block title="Consultations">
                        {inspection.coordination.consultations.length ? (
                          inspection.coordination.consultations.map((c, i) => (
                            <div key={i} className="rounded-lg bg-slate-900/40 p-2.5 text-[12px]">
                              <div className="text-cyan-400">
                                {c.from} → {c.to}{" "}
                                <span className="text-slate-600">({c.status})</span>
                              </div>
                              <div className="mt-1 text-slate-400">{c.reason}</div>
                              {c.response && (
                                <div className="mt-1 text-slate-500">↩ {c.response.slice(0, 300)}</div>
                              )}
                            </div>
                          ))
                        ) : (
                          <Empty>No consultations occurred.</Empty>
                        )}
                      </Block>
                      <Block title="Hand-offs">
                        {inspection.coordination.handoffs.length ? (
                          inspection.coordination.handoffs.map((h, i) => (
                            <div key={i} className="text-[12px] text-slate-400">
                              {h.from} → {h.to}: {h.reason}{" "}
                              <span className="text-slate-600">({h.disposition})</span>
                            </div>
                          ))
                        ) : (
                          <Empty>No hand-offs occurred.</Empty>
                        )}
                      </Block>
                      <Block title="Phases">
                        {inspection.coordination.phases.map((p, i) => (
                          <div key={i} className="text-[12px] text-slate-400">
                            <span className="text-slate-300">{p.phaseKey}</span> — primary:{" "}
                            {p.primary.join(", ") || "none"} · watching:{" "}
                            {p.watching.join(", ") || "none"}
                          </div>
                        ))}
                      </Block>
                    </div>
                  )}

                  {tab === "events" && (
                    <div className="space-y-0.5">
                      {inspection.ledger.map((l, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[52px_170px_1fr] gap-3 rounded px-2 py-1 text-[12px] odd:bg-slate-900/30"
                        >
                          <span className="font-mono text-slate-600">{l.time}</span>
                          <span className="font-mono text-[11px] text-slate-500">{l.eventType}</span>
                          <span className="text-slate-400">{l.summary}</span>
                        </div>
                      ))}
                      {!inspection.ledger.length && <Empty>No ledger entries.</Empty>}
                    </div>
                  )}

                  {tab === "memory" && (
                    <div className="space-y-1.5">
                      {inspection.memoryAtTime.length ? (
                        inspection.memoryAtTime.map((m, i) => (
                          <div key={i} className="rounded-lg bg-slate-900/40 p-2.5 text-[12px]">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-slate-800 px-1.5 py-px text-[9px] uppercase tracking-wider text-slate-400">
                                {m.positionKey}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                seen ×{m.observationCount} · {m.promotionStatus}
                              </span>
                              {!m.existedBefore && (
                                <span className="text-[10px] text-emerald-500">
                                  created by this session
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-slate-400">{m.content}</div>
                          </div>
                        ))
                      ) : (
                        <Empty>No faculty memory existed or was created here.</Empty>
                      )}
                    </div>
                  )}

                  {tab === "output" && (
                    <div className="space-y-2">
                      {inspection.contributions.map((c, i) => (
                        <div key={i} className="rounded-lg border border-slate-800 p-3">
                          <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider">
                            <span className="rounded bg-slate-800 px-1.5 py-px text-slate-300">
                              {c.positionKey}
                            </span>
                            <span className="text-slate-500">{c.contributionType}</span>
                            <span className="text-slate-600">
                              {c.truthClass} · {c.confidence}
                            </span>
                            {c.stance === "dissent" && (
                              <span className="text-rose-400">dissent preserved</span>
                            )}
                          </div>
                          <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-400">
                            {c.content.slice(0, 1400)}
                          </div>
                        </div>
                      ))}
                      {!inspection.contributions.length && <Empty>No contributions recorded.</Empty>}
                    </div>
                  )}
                </section>

                <p className="mt-3 text-[11px] leading-relaxed text-slate-600">{inspection.note}</p>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className="mt-0.5 text-slate-300">{value}</div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-slate-600">{children}</div>;
}
