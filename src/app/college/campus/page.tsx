"use client";

// ============================================================================
// LAYER 8 — THE CAMPUS, as you actually arrive at it.
// ============================================================================
// Two rules shape this page.
//
// 1. THE UI REFLECTS THE COLLEGE'S EPISTEMIC STATE.
//    Not every day needs every section. If nothing changed, the page says so
//    in one line and stops. If you have been gone thirty days, it expands. A
//    section with nothing to say is not rendered at all — an empty heading is
//    a small lie about how much the College knows.
//
// 2. IT IS A PHONE SURFACE FIRST.
//    Single column, large tap targets, safe-area padding, no horizontal
//    scroll. The desktop Control Room does deep work (curriculum, faculty,
//    governance, audit); the phone is the portable campus. Same API, same
//    database, same College State — two windows, not two systems.
//
// The briefing is NOT a source of truth. It renders state resolved elsewhere:
//   Source → Institutional Decision → Operational State → Reality →
//   Temporal State → Interpretation → BRIEFING → Runtime
// ============================================================================

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Interval {
  known: boolean;
  days: number | null;
  since: string | null;
  label: string;
  evidence: string;
}

interface Pattern {
  what: string;
  occurrences: number;
  windowDays: number;
  statedReasons: string[];
  response: string;
}

interface Commitment {
  id: string;
  statement: string;
  status: string;
  dueDate: string | null;
  plannedMinutes: number | null;
  condition: string;
  overdue: boolean;
}

interface Briefing {
  where: {
    longDate: string;
    dayName: string;
    time: string;
    timezone: string;
    currentActivity: string;
    nextActivity: string | null;
  };
  temporal: {
    sinceLastInteraction: Interval;
    sinceLastMeaningfulProgress: Interval;
    sinceLastCollegeSession: Interval;
    sinceLastExternalAcademicEvent: Interval;
    sinceLastReview: Interval;
    goals: Array<{
      id: string;
      title: string;
      status: string;
      condition: string;
      underTimePressure: boolean;
    }>;
    unmeasured: string[];
  };
  changed: {
    since: string | null;
    items: Array<{ what: string; when: string; source: string }>;
    materialCount: number;
    summary: string;
  };
  accountability: {
    made: number;
    completed: number;
    missed: number;
    open: number;
    rhythmDelta: number | null;
    rhythmNote: string;
    summary: string;
    quiet: boolean;
    overdue: Commitment[];
    dueToday: Commitment[];
    patterns: Pattern[];
    settings: { intensity: string };
  };
  matters: {
    external: {
      known: boolean;
      commitments: Array<{
        id: string;
        provider: string;
        title: string;
        status: string;
        condition: string;
        imminent: boolean;
        evidenceLevel: string;
      }>;
    };
    governance: Array<{ what: string; authorityRequired: string }>;
    conditions: string[];
    quiet: boolean;
  };
  next: {
    classAvailable: boolean;
    title: string | null;
    startTime: string | null;
    handoff: string;
  };
  behaviour: { depth: string; continuity: string; reason: string; directive: string };
  note: string;
}

const CONTINUITY_COLOUR: Record<string, string> = {
  no_history: "#64748b",
  normal: "#22c55e",
  short_absence: "#38bdf8",
  extended_absence: "#f59e0b",
  long_absence: "#fb923c",
};

/** A section that simply does not exist when it has nothing to say. */
function Section({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <section
      style={{
        borderTop: "1px solid #1a2333",
        padding: "18px 0 4px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.5,
          color: accent ?? "#475569",
          fontWeight: 700,
          marginBottom: 9,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

export default function CampusPage() {
  const [b, setB] = useState<Briefing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [showTemporal, setShowTemporal] = useState(false);

  const load = useCallback(async (when?: string) => {
    setLoading(true);
    const qs = when ? `?at=${encodeURIComponent(`${when}T09:00:00+10:00`)}` : "";
    try {
      const r = await fetch(`/api/college/briefing${qs}`).then((x) => x.json());
      if (r.error) {
        setErr(r.detail || r.error);
        setB(null);
      } else {
        setB(r.briefing);
        setErr(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading && !b) {
    return (
      <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui", fontSize: 14 }}>
        Resolving institutional state…
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ padding: 28, color: "#fca5a5", fontFamily: "system-ui" }}>
        <p style={{ fontWeight: 700, fontSize: 15 }}>The briefing could not be resolved.</p>
        <p style={{ fontSize: 13, color: "#94a3b8" }}>{err}</p>
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 10, lineHeight: 1.6 }}>
          It reports the failure rather than presenting a partial picture as complete.
        </p>
      </div>
    );
  }

  if (!b) return null;

  const colour = CONTINUITY_COLOUR[b.behaviour.continuity] ?? "#64748b";
  const acc = b.accountability;
  const ext = b.matters.external;

  // Epistemic gating: each section appears only when it holds something real.
  const showChanged = b.changed.materialCount > 0 || b.behaviour.depth !== "quick_orientation";
  const showAccountability = acc.made > 0;
  const showExternal = ext.known && ext.commitments.length > 0;
  const showMatters = b.matters.governance.length > 0 || b.matters.conditions.length > 0;
  const showGoals = b.temporal.goals.length > 0;
  const allQuiet = !showChanged && !showAccountability && !showExternal && !showMatters;

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#0b0f17",
        minHeight: "100vh",
        color: "#e2e8f0",
      }}
    >
      <div
        style={{
          maxWidth: 620,
          margin: "0 auto",
          padding:
            "max(18px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(56px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))",
        }}
      >
        <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>
          ← College
        </Link>

        {/* ---- masthead ---------------------------------------------------- */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 22, letterSpacing: -0.4, fontWeight: 600 }}>
            🏛 LOCHIE COLLEGE
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>{b.where.longDate}</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>
            {b.where.time} {b.where.timezone}
          </div>
        </div>

        {/* ---- CURRENT POSITION -------------------------------------------- */}
        <Section title="CURRENT POSITION" accent={colour}>
          <div style={{ fontSize: 19, fontWeight: 600, color: colour, letterSpacing: -0.3 }}>
            {b.temporal.sinceLastInteraction.label === "today"
              ? "Here today"
              : `${b.temporal.sinceLastInteraction.label} since you were last here`}
          </div>
          <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 6, lineHeight: 1.55 }}>
            {b.behaviour.reason}
          </div>
          <button
            onClick={() => setShowTemporal((v) => !v)}
            style={{
              marginTop: 10,
              padding: "7px 12px",
              background: "#111827",
              border: "1px solid #243044",
              borderRadius: 8,
              color: "#94a3b8",
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "inherit",
              minHeight: 36,
            }}
          >
            {showTemporal ? "Hide" : "Show"} temporal detail
          </button>
          {showTemporal && (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {[
                ["Last meaningful progress", b.temporal.sinceLastMeaningfulProgress],
                ["Last College session", b.temporal.sinceLastCollegeSession],
                ["Last external academic", b.temporal.sinceLastExternalAcademicEvent],
                ["Last review", b.temporal.sinceLastReview],
              ].map(([name, iv]) => {
                const v = iv as Interval;
                return (
                  <div
                    key={name as string}
                    style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5 }}
                  >
                    <span style={{ color: "#64748b" }}>{name as string}</span>
                    <span style={{ color: v.known ? "#cbd5e1" : "#475569", textAlign: "right" }}>
                      {v.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ---- SINCE YOU WERE LAST HERE ------------------------------------ */}
        {showChanged && (
          <Section title="SINCE YOU WERE LAST HERE">
            <div
              style={{
                fontSize: 13.5,
                color: b.changed.materialCount ? "#e2e8f0" : "#64748b",
                lineHeight: 1.55,
              }}
            >
              {b.changed.summary}
            </div>
            {b.changed.items.slice(0, 8).map((c, i) => (
              <div key={i} style={{ marginTop: 9, paddingLeft: 11, borderLeft: "2px solid #243044" }}>
                <div style={{ fontSize: 13, lineHeight: 1.45 }}>{c.what}</div>
                <div style={{ fontSize: 10.5, color: "#475569", marginTop: 2 }}>{c.when}</div>
              </div>
            ))}
          </Section>
        )}

        {/* ---- ACCOUNTABILITY ---------------------------------------------- */}
        {showAccountability && (
          <Section title="ACCOUNTABILITY" accent={acc.quiet ? "#475569" : "#fbbf24"}>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{acc.summary}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 7 }}>
              {acc.completed} / {acc.made} completed
              {acc.missed > 0 && ` · ${acc.missed} missed`}
              {acc.open > 0 && ` · ${acc.open} open`}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 3, lineHeight: 1.5 }}>
              {acc.rhythmNote}
            </div>

            {acc.overdue.slice(0, 4).map((c) => (
              <div
                key={c.id}
                style={{
                  marginTop: 9,
                  padding: "9px 11px",
                  background: "#131a26",
                  border: "1px solid #243044",
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 13 }}>{c.statement}</div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 3, lineHeight: 1.45 }}>
                  {c.condition}
                </div>
              </div>
            ))}

            {acc.patterns.map((p, i) => (
              <div
                key={i}
                style={{
                  marginTop: 11,
                  padding: "11px 13px",
                  background: "#1a1408",
                  border: "1px solid #78350f",
                  borderRadius: 9,
                }}
              >
                <div style={{ fontSize: 10, letterSpacing: 1.3, color: "#fbbf24", fontWeight: 700 }}>
                  PATTERN DETECTED
                </div>
                <div style={{ fontSize: 13, marginTop: 5, lineHeight: 1.45 }}>
                  &ldquo;{p.what}&rdquo; — {p.occurrences} times in {p.windowDays} days.
                </div>
                {p.statedReasons.length > 0 && (
                  <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 4 }}>
                    Stated: {p.statedReasons.join("; ")}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 6, lineHeight: 1.5 }}>
                  {p.response}
                </div>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: "#475569", marginTop: 9 }}>
              intensity: {acc.settings.intensity} · wording only, never authority
            </div>
          </Section>
        )}

        {/* ---- ACADEMIC CONTEXT -------------------------------------------- */}
        {showExternal && (
          <Section title="ACADEMIC CONTEXT">
            {ext.commitments.map((c) => (
              <div
                key={c.id}
                style={{
                  marginTop: 8,
                  padding: "10px 12px",
                  background: c.imminent ? "#1a1408" : "#111827",
                  border: `1px solid ${c.imminent ? "#78350f" : "#1e293b"}`,
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500 }}>{c.provider}</div>
                <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 1 }}>{c.title}</div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 4, lineHeight: 1.45 }}>
                  {c.condition}
                </div>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: "#475569", marginTop: 8, lineHeight: 1.5 }}>
              The provider is the authority. The College records what it was told.
            </div>
          </Section>
        )}

        {/* ---- WHAT MATTERS ------------------------------------------------- */}
        {showMatters && (
          <Section title="WORTH KNOWING">
            {b.matters.governance.map((g, i) => (
              <div
                key={`g${i}`}
                style={{
                  marginTop: 8,
                  padding: "9px 12px",
                  background: "#1a1408",
                  border: "1px solid #78350f",
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 10, letterSpacing: 1.1, color: "#fbbf24", fontWeight: 700 }}>
                  {g.authorityRequired.toUpperCase()}
                </div>
                <div style={{ fontSize: 13, marginTop: 3, lineHeight: 1.45 }}>{g.what}</div>
              </div>
            ))}
            {b.matters.conditions.map((c, i) => (
              <div
                key={`c${i}`}
                style={{
                  fontSize: 12.5,
                  color: "#94a3b8",
                  marginTop: 8,
                  lineHeight: 1.55,
                  paddingLeft: 11,
                  borderLeft: "2px solid #243044",
                }}
              >
                {c}
              </div>
            ))}
          </Section>
        )}

        {/* ---- GOALS -------------------------------------------------------- */}
        {showGoals && (
          <Section title="GOALS">
            {b.temporal.goals.map((g) => (
              <div key={g.id} style={{ marginTop: 7 }}>
                <div style={{ fontSize: 13 }}>
                  {g.title}
                  <span style={{ color: "#475569", fontSize: 11 }}> · {g.status}</span>
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: g.underTimePressure ? "#fbbf24" : "#64748b",
                    marginTop: 2,
                    lineHeight: 1.45,
                  }}
                >
                  {g.condition}
                </div>
              </div>
            ))}
          </Section>
        )}

        {/* ---- the quiet day ------------------------------------------------ */}
        {allQuiet && (
          <Section title="SINCE YOU WERE LAST HERE">
            <div style={{ fontSize: 13.5, color: "#64748b", lineHeight: 1.6 }}>
              No significant changes since your last session.
            </div>
          </Section>
        )}

        {/* ---- TODAY + BEGIN ------------------------------------------------ */}
        <Section title="TODAY" accent="#38bdf8">
          <div style={{ fontSize: 16, fontWeight: 500 }}>{b.where.currentActivity}</div>
          {b.where.nextActivity && (
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
              next — {b.where.nextActivity}
            </div>
          )}
          <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 8, lineHeight: 1.55 }}>
            {b.next.handoff}
          </div>

          <div style={{ display: "grid", gap: 9, marginTop: 15 }}>
            <Link
              href="/college/day"
              style={{
                display: "block",
                padding: "14px 18px",
                background: "#1d4ed8",
                border: "1px solid #2563eb",
                borderRadius: 10,
                color: "#fff",
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
                textAlign: "center",
                minHeight: 48,
              }}
            >
              BEGIN CLASS
            </Link>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
              {[
                ["/college/day", "Today"],
                ["/college/timetable", "Timetable"],
                ["/college/inspector", "Inspect"],
                ["/college/governance", "Governance"],
              ].map(([href, txt]) => (
                <Link
                  key={href}
                  href={href}
                  style={{
                    flex: "1 1 auto",
                    padding: "11px 14px",
                    background: "#111827",
                    border: "1px solid #243044",
                    borderRadius: 9,
                    color: "#94a3b8",
                    fontSize: 12.5,
                    textDecoration: "none",
                    textAlign: "center",
                    minHeight: 42,
                  }}
                >
                  {txt}
                </Link>
              ))}
            </div>
          </div>
        </Section>

        {/* ---- arrive-as-if (inspection, not fiction) ----------------------- */}
        <Section title="ARRIVE AS IF IT WERE">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="date"
              value={at}
              onChange={(e) => {
                setAt(e.target.value);
                void load(e.target.value || undefined);
              }}
              style={{
                padding: "10px 12px",
                background: "#0b0f17",
                border: "1px solid #243044",
                borderRadius: 8,
                color: "#e2e8f0",
                fontSize: 13,
                fontFamily: "inherit",
                minHeight: 42,
              }}
            />
            {at && (
              <button
                onClick={() => {
                  setAt("");
                  void load();
                }}
                style={{
                  padding: "10px 14px",
                  background: "#111827",
                  border: "1px solid #243044",
                  borderRadius: 8,
                  color: "#94a3b8",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  minHeight: 42,
                }}
              >
                back to now
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 8, lineHeight: 1.5 }}>
            Re-asks the question against a different clock. Changes nothing.
          </div>
        </Section>

        <div style={{ fontSize: 10.5, color: "#3f4a5c", marginTop: 20, lineHeight: 1.65 }}>
          {b.note}
        </div>
      </div>
    </div>
  );
}
