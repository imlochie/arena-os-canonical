"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface Dimension {
  key: string;
  label: string;
  status: string;
  observation: string;
  evidence: Record<string, string | number>;
}

interface Report {
  scopeType: string;
  scopeLabel: string;
  period: { start: string; end: string };
  intent: { statement: string; kind: string } | null;
  structure: string;
  dimensions: Dimension[];
  contextualFactors: string[];
  auditStatus: string;
  interpretation: string;
  recommendation: string;
  evidenceQuality: string;
  sufficiency: string;
  observations: number;
}

interface Comparison {
  a: { start: string; end: string; label: string };
  b: { start: string; end: string; label: string };
  rows: { dimension: string; a: string; b: string; changed: boolean }[];
  conditionsDiffer: string[];
  comparable: boolean;
  interpretation: string;
  causationWarning: string;
}

interface ScopeOption {
  id: string;
  label: string;
  type: "slot" | "course";
  sub?: string;
}

const STATUS_COLOR: Record<string, string> = {
  present: "#22c55e",
  absent: "#64748b",
  mixed: "#f59e0b",
  insufficient_evidence: "#64748b",
  not_applicable: "#475569",
};

const AUDIT_COLOR: Record<string, string> = {
  stable: "#22c55e",
  improving: "#22c55e",
  deteriorating: "#f97316",
  changed: "#f59e0b",
  uncertain: "#94a3b8",
  insufficient_evidence: "#64748b",
};

export default function AuditPage() {
  const [scopes, setScopes] = useState<ScopeOption[]>([]);
  const [scope, setScope] = useState<ScopeOption | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [settled, setSettled] = useState<{ settled: boolean; until?: string; reason?: string } | null>(null);
  const [note, setNote] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"audit" | "compare">("audit");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // Build the scope list from the live timetable and the curriculum.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [wk, cur] = await Promise.all([
        fetch("/api/college/timetable-live?view=week").then((r) => r.json()),
        fetch("/api/college/curriculum").then((r) => r.json()).catch(() => ({ activeCourses: [] })),
      ]);
      if (cancelled) return;
      const seen = new Set<string>();
      const opts: ScopeOption[] = [];
      for (const d of wk.days ?? []) {
        for (const s of d.slots ?? []) {
          if (seen.has(s.slotId)) continue;
          seen.add(s.slotId);
          opts.push({
            id: s.slotId,
            label: s.title,
            type: "slot",
            sub: `${d.dayName?.slice(0, 3) ?? ""} ${s.startTime}`,
          });
        }
      }
      for (const c of cur.activeCourses ?? []) {
        opts.push({ id: c.id, label: c.title ?? c.code, type: "course", sub: c.code });
      }
      setScopes(opts);
      const today = new Date().toISOString().slice(0, 10);
      const back = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
      setFrom(back);
      setTo(today);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runAudit = useCallback(async (s: ScopeOption, f: string, t: string) => {
    setBusy(true);
    setComparison(null);
    const r = await fetch(`/api/college/audit?scopeType=${s.type}&scopeId=${s.id}&from=${f}&to=${t}`);
    const d = await r.json();
    setReport(d.report ?? null);
    setSettled(d.settled ?? null);
    setNote(d.note ?? "");
    setBusy(false);
  }, []);

  async function runCompare() {
    if (!scope) return;
    setBusy(true);
    const mid = new Date((new Date(from).getTime() + new Date(to).getTime()) / 2).toISOString().slice(0, 10);
    const r = await fetch(
      `/api/college/audit?scopeType=${scope.type}&scopeId=${scope.id}&compare=1&aStart=${from}&aEnd=${mid}&bStart=${mid}&bEnd=${to}`
    );
    const d = await r.json();
    setComparison(d.comparison ?? null);
    setReport(null);
    setBusy(false);
  }

  async function decide(decision: string) {
    if (!scope) return;
    const decisionReason = window.prompt(
      decision === "keep_as_is"
        ? "Why is this being kept as it is?\n\nThis stops the question being reopened."
        : "Record the reasoning for this decision."
    );
    if (!decisionReason) return;
    setBusy(true);
    const r = await fetch("/api/college/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeType: scope.type, scopeId: scope.id, from, to, decision, decisionReason }),
    });
    const d = await r.json();
    setNote(d.note ?? d.error ?? "");
    setBusy(false);
    await runAudit(scope, from, to);
  }

  if (loading) return <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui" }}>Loading…</div>;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0b0f17", minHeight: "100vh", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "26px 22px 70px" }}>
        <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>← College</Link>
        <h1 style={{ fontSize: 24, margin: "6px 0 4px", letterSpacing: -0.4 }}>Audit</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 22px", maxWidth: 680, lineHeight: 1.6 }}>
          An audit describes what happened and how it compares to what was intended. It does not ask how to
          improve things, and it does not create an obligation to change anything.
        </p>

        {/* controls */}
        <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "15px 17px", marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 130px", gap: 11, alignItems: "end" }}>
            <div>
              <Lbl>Scope</Lbl>
              <select
                value={scope ? `${scope.type}:${scope.id}` : ""}
                onChange={(e) => {
                  const [t, id] = e.target.value.split(":");
                  const s = scopes.find((x) => x.id === id && x.type === t) ?? null;
                  setScope(s);
                  setReport(null);
                  setComparison(null);
                  setSettled(null);
                  setNote("");
                }}
                style={inp}
              >
                <option value="">Select a slot or course…</option>
                <optgroup label="Timetable slots">
                  {scopes.filter((s) => s.type === "slot").map((s) => (
                    <option key={s.id} value={`slot:${s.id}`}>{s.label} — {s.sub}</option>
                  ))}
                </optgroup>
                <optgroup label="Courses">
                  {scopes.filter((s) => s.type === "course").map((s) => (
                    <option key={s.id} value={`course:${s.id}`}>{s.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div>
              <Lbl>From</Lbl>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} />
            </div>
            <div>
              <Lbl>To</Lbl>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
            <button
              disabled={!scope || busy}
              onClick={() => {
                setMode("audit");
                if (scope) void runAudit(scope, from, to);
              }}
              style={{ ...btn, background: mode === "audit" ? "#2563eb" : "#161b26", color: mode === "audit" ? "white" : "#94a3b8" }}
            >
              Run audit
            </button>
            <button
              disabled={!scope || busy}
              onClick={() => {
                setMode("compare");
                void runCompare();
              }}
              style={{ ...btn, background: mode === "compare" ? "#2563eb" : "#161b26", color: mode === "compare" ? "white" : "#94a3b8" }}
            >
              Compare halves
            </button>
          </div>
        </div>

        {settled?.settled && (
          <div style={{ padding: "12px 15px", background: "#13251c", border: "1px solid #15803d", borderRadius: 9, fontSize: 13, color: "#86efac", marginBottom: 16, lineHeight: 1.6 }}>
            <strong>Settled — KEEP AS IS.</strong> Not due for review until {settled.until}.
            {settled.reason && <div style={{ color: "#4ade80", marginTop: 4 }}>{settled.reason}</div>}
          </div>
        )}

        {note && !settled?.settled && (
          <div style={{ padding: "11px 14px", background: "#14243a", border: "1px solid #1d4ed8", borderRadius: 9, fontSize: 12.5, color: "#bfdbfe", marginBottom: 16, lineHeight: 1.6 }}>
            {note}
          </div>
        )}

        {report && <ReportView report={report} onDecide={decide} busy={busy} />}
        {comparison && <ComparisonView c={comparison} />}

        {!report && !comparison && scope && !busy && (
          <div style={{ padding: 24, background: "#0f1420", border: "1px dashed #243044", borderRadius: 11, color: "#64748b", fontSize: 13 }}>
            Choose a time range and run the audit.
          </div>
        )}
      </div>
    </div>
  );
}

function ReportView({ report, onDecide, busy }: { report: Report; onDecide: (d: string) => void; busy: boolean }) {
  const noChange = /NO CHANGE|INSUFFICIENT/.test(report.recommendation);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
      <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "17px 19px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>{report.scopeLabel}</div>
            <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 3 }}>
              {report.period.start} → {report.period.end}
              {report.structure && ` · ${report.structure}`}
              {` · ${report.observations} observation(s)`}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10.5, color: "#64748b", letterSpacing: 1.2 }}>STATUS</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: AUDIT_COLOR[report.auditStatus] ?? "#94a3b8", marginTop: 2 }}>
              {report.auditStatus.replace(/_/g, " ").toUpperCase()}
            </div>
            <div style={{ fontSize: 10.5, color: "#475569", marginTop: 2 }}>evidence: {report.evidenceQuality}</div>
          </div>
        </div>

        {report.intent ? (
          <div style={{ marginTop: 14, padding: "11px 13px", background: "#101a2b", border: "1px solid #1e3a5f", borderRadius: 8 }}>
            <div style={{ fontSize: 10.5, color: "#64748b", letterSpacing: 1.2 }}>INTENT ({report.intent.kind.toUpperCase()})</div>
            <div style={{ fontSize: 13, color: "#bfdbfe", marginTop: 4, lineHeight: 1.55 }}>{report.intent.statement}</div>
          </div>
        ) : (
          <div style={{ marginTop: 14, padding: "11px 13px", background: "#2b2417", border: "1px solid #92400e", borderRadius: 8, fontSize: 12.5, color: "#fcd34d", lineHeight: 1.55 }}>
            No intent recorded for this scope. Without a stated intent, an audit can only describe what
            happened — it cannot say whether it did what it was for.
          </div>
        )}
      </div>

      <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "17px 19px" }}>
        <div style={{ fontSize: 11, letterSpacing: 1.4, color: "#64748b", fontWeight: 700 }}>DIMENSIONS</div>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
          Evaluated separately and never combined into a single score.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {report.dimensions.map((d) => (
            <div key={d.key} style={{ display: "grid", gridTemplateColumns: "132px 1fr", gap: 12, padding: "9px 0", borderTop: "1px solid #161d29" }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 620 }}>{d.label}</div>
                <div style={{ fontSize: 10.5, color: STATUS_COLOR[d.status] ?? "#64748b", marginTop: 2 }}>
                  {d.status.replace(/_/g, " ")}
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: "#cbd5e1", lineHeight: 1.55 }}>{d.observation}</div>
            </div>
          ))}
        </div>
      </div>

      {report.contextualFactors.length > 0 && (
        <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "15px 18px" }}>
          <div style={{ fontSize: 11, letterSpacing: 1.4, color: "#64748b", fontWeight: 700, marginBottom: 9 }}>
            REAL-WORLD CONTEXT IN THIS PERIOD
          </div>
          {report.contextualFactors.map((f, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "#cbd5e1", lineHeight: 1.6 }}>· {f}</div>
          ))}
          <div style={{ fontSize: 11, color: "#475569", marginTop: 9, lineHeight: 1.5 }}>
            Real-world interruption is not schedule failure.
          </div>
        </div>
      )}

      <div style={{ background: noChange ? "#13251c" : "#0f1420", border: `1px solid ${noChange ? "#15803d" : "#1e2637"}`, borderRadius: 11, padding: "17px 19px" }}>
        <div style={{ fontSize: 11, letterSpacing: 1.4, color: noChange ? "#4ade80" : "#64748b", fontWeight: 700 }}>CONCLUSION</div>
        <div style={{ fontSize: 15, fontWeight: 650, marginTop: 7, color: noChange ? "#86efac" : "#e2e8f0", lineHeight: 1.5 }}>
          {report.recommendation}
        </div>
        <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 8, lineHeight: 1.6 }}>{report.interpretation}</div>
        <div style={{ fontSize: 11.5, color: "#475569", marginTop: 7 }}>{report.sufficiency}</div>

        <div style={{ display: "flex", gap: 8, marginTop: 15, flexWrap: "wrap" }}>
          <button onClick={() => onDecide("keep_as_is")} disabled={busy} style={{ ...btn, background: "#15803d", color: "white" }}>
            Keep as is
          </button>
          <button onClick={() => onDecide("investigate")} disabled={busy} style={{ ...btn, background: "#161b26", color: "#94a3b8" }}>
            Investigate
          </button>
          <button onClick={() => onDecide("propose_change")} disabled={busy} style={{ ...btn, background: "#161b26", color: "#94a3b8" }}>
            Propose a change
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 9, lineHeight: 1.5 }}>
          &ldquo;Keep as is&rdquo; is a real institutional decision. It is recorded and stops the question being
          reopened until the configured review interval has passed.
        </div>
      </div>
    </div>
  );
}

function ComparisonView({ c }: { c: Comparison }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
      {!c.comparable && (
        <div style={{ padding: "13px 15px", background: "#2b2417", border: "1px solid #d97706", borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fcd34d" }}>These periods are not a clean experiment.</div>
          {c.conditionsDiffer.map((x, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "#fde68a", marginTop: 6, lineHeight: 1.55 }}>· {x}</div>
          ))}
        </div>
      )}

      <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "17px 19px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "118px 1fr 1fr", gap: 12, fontSize: 10.5, color: "#64748b", letterSpacing: 1.2, fontWeight: 700, paddingBottom: 9 }}>
          <div>DIMENSION</div>
          <div>{c.a.label} · {c.a.start} → {c.a.end}</div>
          <div>{c.b.label} · {c.b.start} → {c.b.end}</div>
        </div>
        {c.rows.map((r) => (
          <div key={r.dimension} style={{ display: "grid", gridTemplateColumns: "118px 1fr 1fr", gap: 12, padding: "10px 0", borderTop: "1px solid #161d29" }}>
            <div style={{ fontSize: 12.5, fontWeight: 620 }}>
              {r.dimension}
              {r.changed && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 2 }}>differs</div>}
            </div>
            <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>{r.a}</div>
            <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>{r.b}</div>
          </div>
        ))}
      </div>

      <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "16px 19px" }}>
        <div style={{ fontSize: 13.5, color: "#e2e8f0", lineHeight: 1.6 }}>{c.interpretation}</div>
        <div style={{ fontSize: 11.5, color: "#475569", marginTop: 10, lineHeight: 1.6 }}>{c.causationWarning}</div>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, color: "#64748b", letterSpacing: 1.1, marginBottom: 5, fontWeight: 600 }}>{children}</div>;
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", background: "#0b0f17", border: "1px solid #243044",
  borderRadius: 7, color: "#e2e8f0", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

const btn: React.CSSProperties = {
  padding: "9px 17px", border: "1px solid #243044", borderRadius: 8,
  fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
};
