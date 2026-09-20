"use client";

// ============================================================================
// LAYER 7 — the Campus Briefing, as the student actually arrives at it.
// ============================================================================
// The founder's instruction shapes this page: "time since last meaningful
// interaction" is the FIRST field, not something buried inside an AI context
// blob. If it is visible, the College can be reasoned about. If it is hidden,
// we are back to the black-box briefing that failed.
//
// Everything here is rendered from computed state. There is no "generate"
// button, because there is nothing to generate.
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
      sinceReview: Interval;
    }>;
    unmeasured: string[];
  };
  changed: {
    since: string | null;
    items: Array<{ what: string; when: string; source: string }>;
    materialCount: number;
    summary: string;
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
      implication: string;
    };
    governance: Array<{ what: string; authorityRequired: string; why: string }>;
    conditions: string[];
    quiet: boolean;
  };
  next: {
    classAvailable: boolean;
    title: string | null;
    courseId: string | null;
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

const card: React.CSSProperties = {
  background: "#0e1420",
  border: "1px solid #1e293b",
  borderRadius: 11,
  padding: "15px 17px",
};

const label: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1.4,
  color: "#475569",
  fontWeight: 700,
};

export default function CampusPage() {
  const [b, setB] = useState<Briefing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [loading, setLoading] = useState(true);

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
    return <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui" }}>Resolving institutional state…</div>;
  }

  if (err) {
    return (
      <div style={{ padding: 40, color: "#fca5a5", fontFamily: "system-ui" }}>
        <p style={{ fontWeight: 700 }}>The briefing could not be resolved.</p>
        <p style={{ fontSize: 13, color: "#94a3b8" }}>{err}</p>
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
          It reports the failure rather than presenting a partial picture as complete.
        </p>
      </div>
    );
  }

  if (!b) return null;

  const colour = CONTINUITY_COLOUR[b.behaviour.continuity] ?? "#64748b";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0b0f17", minHeight: "100vh", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "26px 22px 70px" }}>
        <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>
          ← College
        </Link>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
          <div>
            <h1 style={{ fontSize: 27, margin: 0, letterSpacing: -0.6 }}>CAMPUS</h1>
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
              {b.where.longDate} · {b.where.time} {b.where.timezone}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#475569" }}>arrive as if it were</span>
            <input
              type="date"
              value={at}
              onChange={(e) => {
                setAt(e.target.value);
                void load(e.target.value || undefined);
              }}
              style={{ padding: "7px 10px", background: "#0b0f17", border: "1px solid #243044", borderRadius: 7, color: "#e2e8f0", fontSize: 12.5, fontFamily: "inherit" }}
            />
            {at && (
              <button
                onClick={() => {
                  setAt("");
                  void load();
                }}
                style={{ padding: "7px 11px", background: "#161b26", border: "1px solid #243044", borderRadius: 7, color: "#94a3b8", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
              >
                now
              </button>
            )}
          </div>
        </div>

        {/* ---- TIME SINCE LAST MEANINGFUL INTERACTION — first, deliberately -- */}
        <div style={{ ...card, marginTop: 16, borderColor: colour, borderWidth: 1 }}>
          <div style={label}>TIME SINCE LAST MEANINGFUL INTERACTION</div>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 6, letterSpacing: -0.8, color: colour }}>
            {b.temporal.sinceLastInteraction.label}
          </div>
          <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 3 }}>
            {b.temporal.sinceLastInteraction.evidence}
          </div>
          <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid #1e293b" }}>
            <span style={{ fontSize: 11, letterSpacing: 1.2, color: colour, fontWeight: 700 }}>
              {b.behaviour.continuity.toUpperCase().replace(/_/g, " ")}
            </span>
            <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 4, lineHeight: 1.5 }}>{b.behaviour.reason}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, lineHeight: 1.5, fontStyle: "italic" }}>
              → {b.behaviour.directive}
            </div>
          </div>
        </div>

        {/* ---- the other measured intervals ---------------------------------- */}
        <div style={{ ...card, marginTop: 12 }}>
          <div style={label}>TEMPORAL STATE</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginTop: 9 }}>
            {[
              ["Last meaningful progress", b.temporal.sinceLastMeaningfulProgress],
              ["Last College session", b.temporal.sinceLastCollegeSession],
              ["Last external academic", b.temporal.sinceLastExternalAcademicEvent],
              ["Last review", b.temporal.sinceLastReview],
            ].map(([name, iv]) => {
              const v = iv as Interval;
              return (
                <div key={name as string}>
                  <div style={{ fontSize: 11, color: "#64748b" }}>{name as string}</div>
                  <div style={{ fontSize: 14, marginTop: 2, color: v.known ? "#e2e8f0" : "#475569" }}>
                    {v.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ---- WHERE ARE WE -------------------------------------------------- */}
        <div style={{ ...card, marginTop: 12 }}>
          <div style={label}>WHERE ARE WE</div>
          <div style={{ fontSize: 16, marginTop: 5 }}>{b.where.currentActivity}</div>
          {b.where.nextActivity && (
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>next — {b.where.nextActivity}</div>
          )}
        </div>

        {/* ---- WHAT CHANGED --------------------------------------------------- */}
        <div style={{ ...card, marginTop: 12 }}>
          <div style={label}>WHAT CHANGED</div>
          <div style={{ fontSize: 13, color: b.changed.materialCount ? "#e2e8f0" : "#64748b", marginTop: 5, lineHeight: 1.5 }}>
            {b.changed.summary}
          </div>
          {b.changed.items.slice(0, 10).map((c, i) => (
            <div key={i} style={{ marginTop: 7, paddingLeft: 11, borderLeft: "2px solid #243044" }}>
              <div style={{ fontSize: 12.5 }}>{c.what}</div>
              <div style={{ fontSize: 10.5, color: "#475569", marginTop: 1 }}>
                {c.when} · {c.source}
              </div>
            </div>
          ))}
        </div>

        {/* ---- WHAT MATTERS --------------------------------------------------- */}
        <div style={{ ...card, marginTop: 12 }}>
          <div style={label}>WHAT MATTERS</div>
          {b.matters.quiet ? (
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
              Nothing requires a decision. <span style={{ color: "#22c55e" }}>NO CHANGE INDICATED.</span>
            </div>
          ) : (
            <>
              {b.matters.governance.map((g, i) => (
                <div key={`g${i}`} style={{ marginTop: 8, padding: "8px 11px", background: "#1a1408", border: "1px solid #78350f", borderRadius: 7 }}>
                  <div style={{ fontSize: 10, letterSpacing: 1.1, color: "#fbbf24", fontWeight: 700 }}>
                    {g.authorityRequired.toUpperCase()}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 3 }}>{g.what}</div>
                </div>
              ))}
              {b.matters.conditions.map((c, i) => (
                <div key={`c${i}`} style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 7, lineHeight: 1.5, paddingLeft: 11, borderLeft: "2px solid #243044" }}>
                  {c}
                </div>
              ))}
            </>
          )}
        </div>

        {/* ---- EXTERNAL ACADEMIC ---------------------------------------------- */}
        {b.matters.external.known && (
          <div style={{ ...card, marginTop: 12 }}>
            <div style={label}>EXTERNAL ACADEMIC</div>
            {b.matters.external.commitments.map((c) => (
              <div
                key={c.id}
                style={{
                  marginTop: 8,
                  padding: "9px 12px",
                  background: c.imminent ? "#1a1408" : "#0b0f17",
                  border: `1px solid ${c.imminent ? "#78350f" : "#1e293b"}`,
                  borderRadius: 7,
                }}
              >
                <div style={{ fontSize: 13 }}>
                  {c.provider} — {c.title}
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 3, lineHeight: 1.45 }}>{c.condition}</div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 3 }}>
                  evidence: {c.evidenceLevel} · status: {c.status}
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "#475569", marginTop: 9, lineHeight: 1.5 }}>
              The provider is the authority. The College records what it was told and never asserts an external result.
            </div>
          </div>
        )}

        {/* ---- WHAT'S NEXT ---------------------------------------------------- */}
        <div style={{ ...card, marginTop: 12, borderColor: "#1e3a5f" }}>
          <div style={label}>WHAT&apos;S NEXT</div>
          <div style={{ fontSize: 13.5, marginTop: 5, lineHeight: 1.5 }}>{b.next.handoff}</div>
          <div style={{ display: "flex", gap: 9, marginTop: 12, flexWrap: "wrap" }}>
            <Link
              href="/college/day"
              style={{ padding: "8px 15px", background: "#1e293b", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12.5, textDecoration: "none" }}
            >
              Open the day →
            </Link>
            <Link
              href="/college/inspector"
              style={{ padding: "8px 15px", background: "#161b26", border: "1px solid #243044", borderRadius: 7, color: "#94a3b8", fontSize: 12.5, textDecoration: "none" }}
            >
              Inspect a session
            </Link>
            {b.matters.governance.length > 0 && (
              <Link
                href="/college/governance"
                style={{ padding: "8px 15px", background: "#1a1408", border: "1px solid #78350f", borderRadius: 7, color: "#fbbf24", fontSize: 12.5, textDecoration: "none" }}
              >
                {b.matters.governance.length} awaiting decision →
              </Link>
            )}
          </div>
        </div>

        <div style={{ fontSize: 11, color: "#475569", marginTop: 16, lineHeight: 1.6 }}>
          {b.note}
        </div>
      </div>
    </div>
  );
}
