"use client";

import { useEffect, useState } from "react";

// Faculty attention & coordination viewer.
// Makes visible what the orchestrator decided: who attended, who spoke, who
// stayed dormant, and why. Structured provenance only — never internal
// reasoning.

interface Policy {
  positionKey: string;
  name: string;
  branch: string;
  attentionScope: string;
  relevantPhases: string[];
  triggers: Array<{ event: string; priority: string; because: string }>;
  activationConditions: string[];
  silenceConditions: string[];
  deferMatters: Array<{ matter: string; to: string }>;
  interruptionAuthority: string;
  mayConsult: string[];
  mayHandOffTo: string[];
  defaultState: string;
}

interface TraceEntry {
  at: string;
  kind: string;
  actor: string;
  summary: string;
  detail: string;
}

interface AttentionRow {
  positionKey: string;
  name: string;
  state: string;
  reason: string;
  spoke: boolean;
}

const STATE_STYLE: Record<string, string> = {
  dormant: "border-slate-700/50 bg-slate-800/20 text-slate-500",
  watching: "border-sky-500/30 bg-sky-500/5 text-sky-300",
  engaged: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  consulting: "border-violet-500/40 bg-violet-500/10 text-violet-200",
  waiting: "border-amber-500/30 bg-amber-500/5 text-amber-200",
  deferred: "border-slate-600/40 bg-slate-800/20 text-slate-400",
  escalated: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  handing_off: "border-indigo-500/30 bg-indigo-500/5 text-indigo-200",
  completed: "border-slate-600/40 bg-slate-800/20 text-slate-400",
};

const KIND_STYLE: Record<string, string> = {
  phase: "border-indigo-500/40 text-indigo-300",
  event: "border-amber-500/40 text-amber-300",
  attention: "border-sky-500/30 text-sky-300",
  consultation: "border-violet-500/40 text-violet-300",
  handoff: "border-emerald-500/40 text-emerald-300",
  interruption: "border-rose-500/40 text-rose-300",
};

const AUTHORITY_LABEL: Record<string, string> = {
  none: "may never interrupt",
  request: "may request only",
  material: "may interrupt if material",
  integrity: "may interrupt for integrity",
};

export default function FacultyCoordination() {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [sessionId, setSessionId] = useState("");
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [attention, setAttention] = useState<AttentionRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<"policies" | "session">("policies");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, s] = await Promise.all([
        fetch("/api/college/attention").then((r) => r.json()).catch(() => null),
        fetch("/api/college/sessions").then((r) => r.json()).catch(() => null),
      ]);
      if (cancelled) return;
      if (p?.policies) setPolicies(p.policies);
      if (s?.sessions) {
        const list = s.sessions.map((x: { id: string; title: string }) => ({
          id: x.id,
          title: x.title,
        }));
        setSessions(list);
        if (list.length) setSessionId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const r = await fetch(`/api/college/attention?sessionId=${sessionId}`)
        .then((x) => x.json())
        .catch(() => null);
      if (cancelled || !r) return;
      setTrace(r.trace ?? []);
      setAttention(r.attention ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!policies) return <p className="py-20 text-center text-slate-400">Loading faculty model…</p>;

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-950/40 via-[#0a0f22] to-[#060a17] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-300/70">
          Orchestration, not prompts
        </p>
        <h1 className="mt-1 text-2xl font-black tracking-tight text-white">
          Faculty attention &amp; coordination
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Each position knows when to pay attention, when to act, when to stay silent, and when to
          cooperate. Attending is not the same as speaking.
        </p>
        <div className="mt-3 flex gap-2 border-t border-white/10 pt-3">
          {(["policies", "session"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-bold ${
                tab === t
                  ? "bg-indigo-600/80 text-white"
                  : "border border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
              }`}
            >
              {t === "policies" ? "Attention policies" : "Session trace"}
            </button>
          ))}
        </div>
      </header>

      {tab === "policies" ? (
        <div className="space-y-3">
          {policies.map((p) => (
            <section
              key={p.positionKey}
              className={`rounded-2xl border bg-white/[0.03] p-4 ${
                p.branch === "administration" ? "border-amber-500/25" : "border-white/10"
              }`}
            >
              <button
                onClick={() => setExpanded(expanded === p.positionKey ? null : p.positionKey)}
                className="flex w-full items-start justify-between gap-3 text-left"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[14px] font-extrabold text-white">{p.name}</h2>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                        p.branch === "administration"
                          ? "border-amber-500/40 text-amber-300"
                          : "border-emerald-500/30 text-emerald-300"
                      }`}
                    >
                      {p.branch}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                        STATE_STYLE[p.defaultState] ?? "border-slate-600/40 text-slate-400"
                      }`}
                    >
                      opens {p.defaultState}
                    </span>
                    <span className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                      {AUTHORITY_LABEL[p.interruptionAuthority] ?? p.interruptionAuthority}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-slate-400">{p.attentionScope}</p>
                </div>
                <span className="shrink-0 text-slate-500">{expanded === p.positionKey ? "−" : "+"}</span>
              </button>

              {expanded === p.positionKey && (
                <div className="mt-3 grid gap-3 border-t border-white/10 pt-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300/70">
                      Wakes on
                    </p>
                    <ul className="space-y-1">
                      {p.triggers.map((t) => (
                        <li key={t.event} className="text-[11px] text-slate-300">
                          <span className="font-mono text-[10px] text-emerald-300">{t.event}</span>{" "}
                          <span className="rounded border border-white/15 px-1 text-[9px] uppercase text-slate-400">
                            {t.priority}
                          </span>
                          <br />
                          <span className="text-slate-500">{t.because}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Stays silent when
                    </p>
                    <ul className="space-y-1">
                      {p.silenceConditions.map((c, i) => (
                        <li key={i} className="text-[11px] text-slate-400">
                          · {c}
                        </li>
                      ))}
                    </ul>
                    <p className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-wider text-rose-300/70">
                      Not its to answer
                    </p>
                    <ul className="space-y-1">
                      {p.deferMatters.map((d, i) => (
                        <li key={i} className="text-[11px] text-slate-400">
                          · {d.matter} → <span className="text-rose-300">{d.to}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-[11px] text-slate-500">
                      <span className="text-slate-400">Relevant phases:</span>{" "}
                      {p.relevantPhases.join(", ") || "none"} ·{" "}
                      <span className="text-slate-400">may consult:</span>{" "}
                      {p.mayConsult.join(", ") || "none"} ·{" "}
                      <span className="text-slate-400">may hand off to:</span>{" "}
                      {p.mayHandOffTo.join(", ") || "none"}
                    </p>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <label className="mb-2 block text-[11px] uppercase tracking-wide text-slate-500">
              Session
            </label>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>

          {attention.length ? (
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h2 className="mb-1 text-[13px] font-extrabold uppercase tracking-wider text-white">
                Final attention state
              </h2>
              <p className="mb-3 text-[11px] italic text-slate-500">
                A position can attend without speaking
              </p>
              <ul className="space-y-1.5">
                {attention.map((a) => (
                  <li
                    key={a.positionKey}
                    className={`rounded-lg border px-3 py-2 ${
                      STATE_STYLE[a.state] ?? "border-white/10 bg-black/20 text-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-bold">{a.name}</span>
                      <span className="font-mono text-[10px] uppercase">
                        {a.state}
                        {a.spoke ? " · spoke" : " · silent"}
                      </span>
                    </div>
                    <p className="text-[11px] opacity-80">{a.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="mb-1 text-[13px] font-extrabold uppercase tracking-wider text-white">
              Coordination trace
            </h2>
            <p className="mb-3 text-[11px] italic text-slate-500">
              Structured actions, reasons and outcomes — not internal reasoning
            </p>
            {trace.length ? (
              <ol className="space-y-1.5">
                {trace.map((t, i) => (
                  <li key={i} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                          KIND_STYLE[t.kind] ?? "border-slate-600/40 text-slate-400"
                        }`}
                      >
                        {t.kind}
                      </span>
                      <span className="text-[12px] font-semibold text-white">{t.summary}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-600">{t.actor}</span>
                    </div>
                    {t.detail ? <p className="mt-0.5 text-[11px] text-slate-400">{t.detail}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] text-slate-500">
                No coordination trace for this session. It may predate the orchestrator.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
