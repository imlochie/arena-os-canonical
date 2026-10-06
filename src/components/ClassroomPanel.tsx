"use client";

// Classroom — Lochie Life College as an institutional experience.
//
// The page shows institutional state (current class, academic week, theme,
// faculty, continuity) and the class in progress: a Faculty-led lesson that
// advances through bounded phases, pausing at student checkpoints. The
// conversation is one surface inside the institution — this is not a blank
// chat. The date control lets the owner browse the semester (explicit
// simulation); by default it resolves today from the academic calendar.

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";

interface Resolved {
  isoDate: string;
  weekday: string;
  classroom: { key: string; name: string; purpose: string };
  faculty: { name: string; subjectDomain: string; methods: string[]; methodsDocumented: boolean };
  weekNumber: number;
  weekState: "before" | "within" | "beyond";
  weekTheme: string | null;
  weekNote: string;
}

interface Relay {
  id: string;
  seq: number;
  sourceKey: string;
  targetKey: string;
  purpose: string;
  request: string;
  status: string;
  response: string | null;
  via: string;
  note: string;
  toolUse: boolean;
  steps: { tool: string; ok: boolean; ms: number; summary: string }[];
}

interface State {
  college: { name: string; philosophy: string; motto: string; principle: string };
  semester: { name: string; week1Monday: string };
  resolved: Resolved;
  occurrence: { date: string; phase: string; status: string; weekNumber: number } | null;
  collaboration: { title: string; participants: { key: string; name: string; emoji: string; kind: string }[]; relays: Relay[] } | null;
  pendingCheckpoint: Relay | null;
  previousRecord: { kind: string; content: string; weekNumber: number | null } | null;
  memory: { id: string; kind: string; content: string; weekNumber: number | null; createdAt: string }[];
  courses: { code: string; name: string; curriculum: { week: number; title: string }[]; state: string }[];
}

const PHASES = ["orientation", "lesson", "practice", "discussion", "check", "reflection", "record", "complete"];

const STATUS_STYLE: Record<string, string> = {
  waiting: "bg-slate-400/10 text-slate-300 ring-slate-400/20",
  in_session: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20",
  complete: "bg-cyan-400/10 text-cyan-200 ring-cyan-400/20",
  pending: "bg-amber-400/10 text-amber-200 ring-amber-400/20",
  responded: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20",
  failed: "bg-rose-400/10 text-rose-200 ring-rose-400/20",
  cancelled: "bg-slate-400/10 text-slate-300 ring-slate-400/20",
};

function Badge({ text, style }: { text: string; style: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ring-1 ${style}`}>{text}</span>;
}

export default function ClassroomPanel() {
  const [date, setDate] = useState(""); // simulated date; "" = today
  const [state, setState] = useState<State | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [answer, setAnswer] = useState("");
  const autoRef = useRef(false);

  const load = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/classroom${d ? `?date=${d}` : ""}`);
      if (res.ok) setState(await res.json());
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      void load(date);
    })();
  }, [load, date]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch("/api/classroom/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: date || undefined, keys: loadKeys(), localOnly: privacyFlags().localOnly }),
      });
      const data = await res.json();
      if (res.ok) {
        setState(data.state);
        setNotice("Class started — the Faculty is assembling.");
      } else setNotice(data.error ?? "failed to start class");
    } finally {
      setBusy(false);
    }
  }

  async function advance(): Promise<{ ran: string; note: string } | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const res = await fetch("/api/classroom/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: date || undefined, keys: loadKeys(), localOnly: privacyFlags().localOnly }),
      });
      const data = await res.json();
      if (res.ok) {
        setState(data.state);
        setNotice(data.note ?? "");
        return { ran: data.ran, note: data.note };
      }
      setNotice(data.error ?? "advance failed");
      return null;
    } catch {
      setNotice("network error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // auto-run: the client-driven conductor — advances until a checkpoint or
  // completion (no server workers; stops when the tab hides or the student
  // must participate)
  useEffect(() => {
    autoRef.current = autoRun;
    if (!autoRun) return;
    void (async () => {
      while (autoRef.current) {
        if (document.visibilityState !== "visible") break;
        if (state?.pendingCheckpoint || state?.occurrence?.status === "complete") {
          setAutoRun(false);
          break;
        }
        const result = await advance();
        if (!result || result.ran === "checkpoint" || result.ran === "complete" || result.ran === "not-started" || result.ran === "closed") {
          setAutoRun(false);
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  async function respond(rejected: boolean) {
    if (!state?.pendingCheckpoint || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/classroom/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relayId: state.pendingCheckpoint.id, response: answer.trim() || undefined, rejected }),
      });
      if (res.ok) {
        setAnswer("");
        setNotice(rejected ? "Declined — noted in the record." : "Noted. The class continues.");
        await load(date);
      }
    } finally {
      setBusy(false);
    }
  }

  const resolved = state?.resolved;
  const occurrence = state?.occurrence;
  const phaseIndex = occurrence ? PHASES.indexOf(occurrence.phase) : -1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ---- institutional header ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">🎓 {state?.college.name ?? "Lochie Life College"}</h1>
          <p className="mt-1 text-xs text-slate-400">
            {state?.college.philosophy && (
              <>
                “{state.college.philosophy}” · motto: “{state.college.motto}” · <em>“{state.college.principle}”</em>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            title="Browse/simulate a date (empty = today, resolved from the academic calendar)"
            className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/60"
          />
          {date && (
            <button
              onClick={() => setDate("")}
              className="rounded-xl bg-white/5 px-2.5 py-2 text-[10px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            >
              today
            </button>
          )}
        </div>
      </div>

      {notice && <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-2.5 text-xs text-cyan-100">{notice}</div>}

      {/* ---- institutional state ---- */}
      {state && resolved && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            {/* current class card */}
            <div className="glass rounded-2xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="archive-mono text-[10px] font-bold uppercase tracking-[.18em] text-cyan-300">
                    {resolved.weekday} · {state.semester.name}
                  </div>
                  <h2 className="mt-1 text-xl font-extrabold text-white">
                    {resolved.classroom.name}
                    <span className="ml-2 text-sm font-bold text-slate-400">{resolved.faculty.name}</span>
                  </h2>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">{resolved.classroom.purpose}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  {occurrence ? (
                    <Badge text={occurrence.status === "complete" ? "complete" : occurrence.status.replace("_", " ")} style={STATUS_STYLE[occurrence.status] ?? STATUS_STYLE.waiting} />
                  ) : (
                    <Badge text="waiting" style={STATUS_STYLE.waiting} />
                  )}
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-300 ring-1 ring-white/10">
                    Week {resolved.weekNumber}
                  </span>
                </div>
              </div>

              <div className="mt-3 rounded-xl bg-black/30 p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Week theme</div>
                {resolved.weekTheme ? (
                  <div className="mt-0.5 text-sm font-bold text-cyan-100">{resolved.weekTheme}</div>
                ) : (
                  <div className="mt-0.5 text-xs italic text-amber-200/80">{resolved.weekNote}</div>
                )}
              </div>

              {/* phase progress */}
              {occurrence && occurrence.status !== "waiting" && (
                <div className="mt-3">
                  <div className="flex gap-1">
                    {PHASES.map((phase, i) => (
                      <div
                        key={phase}
                        title={phase}
                        className={`h-1.5 flex-1 rounded-full ${
                          i < phaseIndex ? "bg-cyan-400/60" : i === phaseIndex ? "bg-cyan-300" : "bg-white/10"
                        } ${occurrence.phase === "complete" ? "bg-cyan-400/60" : ""}`}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    {occurrence.phase === "complete" ? "class complete — record filed" : `phase: ${occurrence.phase}`}
                  </div>
                </div>
              )}

              {/* actions */}
              <div className="mt-4 flex flex-wrap gap-2">
                {!occurrence || occurrence.status === "waiting" ? (
                  <button
                    onClick={() => void start()}
                    disabled={busy || resolved.weekState === "before"}
                    className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black text-black transition hover:bg-cyan-400 disabled:opacity-40"
                  >
                    ▶ Start today&apos;s class
                  </button>
                ) : occurrence.status === "in_session" ? (
                  <>
                    <button
                      onClick={() => void advance()}
                      disabled={busy || Boolean(state.pendingCheckpoint)}
                      className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black text-black transition hover:bg-cyan-400 disabled:opacity-40"
                    >
                      {busy ? "…" : "▶ Advance"}
                    </button>
                    <button
                      onClick={() => setAutoRun((v) => !v)}
                      disabled={Boolean(state.pendingCheckpoint)}
                      className={`rounded-xl px-3 py-2 text-xs font-black ring-1 transition disabled:opacity-40 ${
                        autoRun
                          ? "bg-amber-400/20 text-amber-100 ring-amber-400/40"
                          : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                      }`}
                      title="The conductor advances the class automatically until a student checkpoint or completion"
                    >
                      {autoRun ? "⏸ Auto-running…" : "▶▶ Auto-run"}
                    </button>
                  </>
                ) : (
                  <span className="text-xs font-bold text-cyan-200">✓ Record filed — see the memory panel and /artifacts.</span>
                )}
              </div>
            </div>

            {/* student checkpoint */}
            {state.pendingCheckpoint && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
                <div className="text-sm font-extrabold text-amber-200">
                  ⏸ Your turn — {state.pendingCheckpoint.purpose}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-slate-300">{state.pendingCheckpoint.request}</p>
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={3}
                  placeholder="your answer — participate, ask, or reflect…"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-amber-400/60"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void respond(false)}
                    disabled={busy}
                    className="rounded-xl bg-emerald-500 px-4 py-1.5 text-xs font-black text-black hover:bg-emerald-400 disabled:opacity-40"
                  >
                    ✓ Respond
                  </button>
                  <button
                    onClick={() => void respond(true)}
                    disabled={busy}
                    className="rounded-xl bg-rose-500/20 px-4 py-1.5 text-xs font-black text-rose-200 hover:bg-rose-500/30 disabled:opacity-40"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}

            {/* lesson timeline */}
            <div className="glass rounded-2xl p-5">
              <h3 className="text-sm font-extrabold text-white">The class</h3>
              <div className="mt-3 space-y-2.5">
                {(!state.collaboration || state.collaboration.relays.length === 0) && (
                  <p className="px-1 py-4 text-center text-xs text-slate-500">
                    No class in progress. Start today&apos;s class and the Faculty opens it — you participate at the marked points.
                  </p>
                )}
                {state.collaboration?.relays.map((r) => {
                  const target = state.collaboration!.participants.find((p) => p.key === r.targetKey);
                  return (
                    <div key={r.id} className="rounded-2xl bg-white/5 p-3.5 ring-1 ring-white/10">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-mono font-bold text-slate-500">#{r.seq}</span>
                        <span className="font-bold text-cyan-200">
                          {target ? `${target.emoji} ${target.name}` : r.targetKey}
                        </span>
                        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{r.purpose}</span>
                        <Badge text={r.status} style={STATUS_STYLE[r.status] ?? STATUS_STYLE.pending} />
                        {r.toolUse && <span title="tool-capable relay">🔧</span>}
                        {r.via && <span className="font-mono text-[9px] text-slate-500">via {r.via}</span>}
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-slate-400">{r.request.slice(0, 300)}</div>
                      {r.steps.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {r.steps.map((s, i) => (
                            <span
                              key={i}
                              title={s.summary}
                              className="rounded-full bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-200 ring-1 ring-cyan-400/20"
                            >
                              🔧 {s.tool} {s.ok ? "✓" : "✗"} {s.ms}ms
                            </span>
                          ))}
                        </div>
                      )}
                      {r.response && (
                        <div className="mt-2 rounded-xl bg-black/30 p-3 text-xs leading-5 text-slate-200">
                          <Markdown text={r.response.slice(0, 4000)} />
                        </div>
                      )}
                      {r.note && <div className="mt-1.5 text-[11px] italic text-rose-300">{r.note}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---- right: institution panels ---- */}
          <div className="space-y-5">
            {/* faculty */}
            <div className="glass rounded-2xl p-4">
              <h3 className="text-sm font-extrabold text-white">Faculty</h3>
              <p className="mt-1 text-xs font-bold text-cyan-200">{resolved.faculty.name}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{resolved.faculty.subjectDomain}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {resolved.faculty.methodsDocumented ? (
                  resolved.faculty.methods.map((m) => (
                    <span key={m} className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-bold text-slate-300">{m}</span>
                  ))
                ) : (
                  <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-200">
                    methods not documented — definition required
                  </span>
                )}
              </div>
              {state.collaboration && (
                <>
                  <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Behind the classroom</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {state.collaboration.participants.map((p) => (
                      <span
                        key={p.key}
                        title={p.kind}
                        className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-300 ring-1 ring-white/10"
                      >
                        {p.emoji} {p.name}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* continuity */}
            <div className="glass rounded-2xl p-4">
              <h3 className="text-sm font-extrabold text-white">Continuity</h3>
              {state.previousRecord ? (
                <div className="mt-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    previous lesson record (week {state.previousRecord.weekNumber ?? "?"})
                  </div>
                  <p className="mt-1 line-clamp-6 text-[11px] leading-4 text-slate-400">{state.previousRecord.content}</p>
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-slate-500">No prior record for this classroom — first documented occurrence.</p>
              )}
              {state.memory.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Educational memory</div>
                  {state.memory.slice(0, 6).map((m) => (
                    <div key={m.id} className="rounded-xl bg-white/5 px-2.5 py-1.5 ring-1 ring-white/10">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-cyan-400/10 px-1 py-0.5 text-[8px] font-black uppercase text-cyan-200">{m.kind}</span>
                        {m.weekNumber != null && <span className="text-[8px] font-bold text-slate-500">wk {m.weekNumber}</span>}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-slate-400">{m.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* courses */}
            <div className="glass rounded-2xl p-4">
              <h3 className="text-sm font-extrabold text-white">Courses (documented pilots)</h3>
              <div className="mt-2 space-y-2">
                {state.courses.map((c) => (
                  <div key={c.code} className="rounded-xl bg-white/5 px-2.5 py-2 ring-1 ring-white/10">
                    <div className="text-[11px] font-bold text-white">
                      {c.code} — {c.name}
                    </div>
                    {c.curriculum.length ? (
                      c.curriculum.map((unit) => (
                        <div key={unit.week} className="mt-0.5 text-[10px] text-slate-400">
                          Week {unit.week}: {unit.title}
                        </div>
                      ))
                    ) : (
                      <div className="mt-0.5 text-[10px] italic text-amber-200/70">{c.state}</div>
                    )}
                    {c.curriculum.length > 0 && c.curriculum.length < 10 && (
                      <div className="mt-0.5 text-[9px] italic text-slate-500">{c.state}</div>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[9px] leading-4 text-slate-600">
                Institutional records are preserved as documented — nothing is invented to fill gaps.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
