"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * THE INSTITUTIONAL DAY
 *
 * What was supposed to happen → what happened → who was involved → why it
 * differed. This is the view where the timetable stops being a grid and starts
 * being the temporal spine of the College.
 */

interface LedgerEntry {
  id: string;
  time: string;
  sequence: number;
  eventType: string;
  summary: string;
  positionKey: string;
  actor: string;
  severity: string;
  sessionId: string | null;
}

interface Slot {
  slotId: string;
  title: string;
  startTime: string;
  endTime: string;
  activityType: string;
  runtimeStatus: string;
  periodLabel?: string;
  courseCode?: string | null;
  generatesSession?: boolean;
  courseId?: string | null;
  override?: { exceptionType: string; reason: string } | null;
}

interface Live {
  date: string;
  time: string;
  dayName: string;
  theme: string;
  current: Slot | null;
  next: Slot | null;
  later: Slot[];
  completed: Slot[];
  concurrent: Slot[];
}

const EVENT_STYLE: Record<string, { color: string; glyph: string }> = {
  class_opened: { color: "#3b82f6", glyph: "▶" },
  class_completed: { color: "#22c55e", glyph: "✓" },
  class_shortened: { color: "#f59e0b", glyph: "⊣" },
  session_closed: { color: "#64748b", glyph: "■" },
  faculty_activated: { color: "#a855f7", glyph: "●" },
  faculty_watching: { color: "#475569", glyph: "○" },
  faculty_consulted: { color: "#06b6d4", glyph: "⇄" },
  faculty_deferred: { color: "#64748b", glyph: "→" },
  observer_noted: { color: "#10b981", glyph: "✎" },
  objective_demonstrated: { color: "#22c55e", glyph: "★" },
  real_world_interruption: { color: "#f97316", glyph: "⚡" },
  timetable_override: { color: "#f59e0b", glyph: "↻" },
  decision_recorded: { color: "#818cf8", glyph: "§" },
  memory_recorded: { color: "#8b5cf6", glyph: "◈" },
  memory_promoted: { color: "#8b5cf6", glyph: "◆" },
  curriculum_change: { color: "#ec4899", glyph: "✱" },
};

const style = (t: string) => EVENT_STYLE[t] ?? { color: "#475569", glyph: "·" };

export default function DayPage() {
  const [live, setLive] = useState<Live | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [notifications, setNotifications] = useState<
    Array<{ id: string; title: string; severity: string; occurrenceCount: number }>
  >([]);
  const [date, setDate] = useState("");
  const [liveState, setLiveState] = useState<{
    current: { kind: string; title: string; startTime: string; endTime: string; completionEvidence: string };
    next: { title: string; startTime: string; inMinutes: number | null } | null;
    faculty: Array<{ positionKey: string; memberName: string; state: string; detail: string }>;
    timetable: { state: string; detail: string };
    governance: { actionable: number; informational: number };
    audit: { state: string; detail: string };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (d?: string) => {
    const qs = d ? `?date=${d}` : "";
    const [tl, led, notif, ls] = await Promise.all([
      fetch(`/api/college/timetable-live${qs}`).then((r) => r.json()),
      fetch(`/api/college/ledger${qs}`).then((r) => r.json()),
      fetch("/api/college/ledger?view=notifications").then((r) => r.json()),
      fetch("/api/college/live").then((r) => r.json()).catch(() => null),
    ]);
    setLive(tl.live ?? null);
    setEntries(led.entries ?? []);
    setNotifications(notif.pending ?? []);
    setLiveState(ls?.state ?? null);
    setDate(led.date ?? d ?? "");
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

  async function noteContext() {
    const summary = window.prompt(
      "What happened in the real world?\n\nThis explains a deviation. It does not change the timetable."
    );
    if (!summary) return;
    setBusy(true);
    await fetch("/api/college/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "real_world_interruption", summary, date }),
    });
    setBusy(false);
    await load(date);
  }

  if (loading) {
    return <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui" }}>Reading the day…</div>;
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0b0f17", minHeight: "100vh", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "26px 22px 70px" }}>
        <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>← College</Link>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
          <div>
            <h1 style={{ fontSize: 27, margin: 0, letterSpacing: -0.6 }}>
              {live?.dayName?.toUpperCase() ?? "DAY"}
              {live?.theme && <span style={{ color: "#f59e0b" }}> — {live.theme}</span>}
            </h1>
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
              {date} · application clock {live?.time} · Australia/Brisbane
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                void load(e.target.value);
              }}
              style={{ padding: "7px 10px", background: "#0b0f17", border: "1px solid #243044", borderRadius: 7, color: "#e2e8f0", fontSize: 12.5, fontFamily: "inherit" }}
            />
            <Link href="/college/timetable" style={{ padding: "7px 14px", background: "#161b26", border: "1px solid #243044", borderRadius: 7, color: "#94a3b8", fontSize: 12.5, textDecoration: "none" }}>
              Timetable
            </Link>
          </div>
        </div>

        {/* RIGHT NOW — the live runtime state (§24). Only meaningful for today. */}
        {liveState && (
          <div
            style={{
              marginTop: 16,
              padding: "13px 16px",
              background: "#0e1420",
              border: "1px solid #1e293b",
              borderRadius: 10,
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr 1.2fr",
              gap: 18,
            }}
          >
            <div>
              <div style={{ fontSize: 10, letterSpacing: 1.3, color: "#475569", fontWeight: 700 }}>
                RIGHT NOW
              </div>
              <div style={{ fontSize: 14.5, marginTop: 4, color: liveState.current.kind === "none" ? "#64748b" : "#e2e8f0" }}>
                {liveState.current.title}
                {liveState.current.startTime && (
                  <span style={{ color: "#64748b", fontSize: 12 }}>
                    {" "}
                    {liveState.current.startTime}
                    {liveState.current.endTime ? `–${liveState.current.endTime}` : ""}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#475569", marginTop: 3, lineHeight: 1.45 }}>
                {liveState.current.completionEvidence}
              </div>
              {liveState.next && (
                <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 6 }}>
                  NEXT — {liveState.next.title} at {liveState.next.startTime}
                  {liveState.next.inMinutes !== null && liveState.next.inMinutes >= 0
                    ? ` (in ${liveState.next.inMinutes} min)`
                    : ""}
                </div>
              )}
            </div>

            <div>
              <div style={{ fontSize: 10, letterSpacing: 1.3, color: "#475569", fontWeight: 700 }}>
                FACULTY
              </div>
              {liveState.faculty.length === 0 ? (
                <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>none configured</div>
              ) : (
                liveState.faculty.slice(0, 6).map((f) => (
                  <div key={f.positionKey} style={{ fontSize: 11.5, marginTop: 3, color: "#94a3b8" }}>
                    {f.memberName}
                    <span
                      style={{
                        color:
                          f.state === "speaking"
                            ? "#22c55e"
                            : f.state === "watching"
                              ? "#38bdf8"
                              : "#475569",
                      }}
                    >
                      {" "}
                      — {f.state}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div>
              <div style={{ fontSize: 10, letterSpacing: 1.3, color: "#475569", fontWeight: 700 }}>
                INSTITUTION
              </div>
              <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 4 }}>
                Timetable — {liveState.timetable.state}
              </div>
              <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 3 }}>
                Governance —{" "}
                {liveState.governance.actionable ? (
                  <Link href="/college/governance" style={{ color: "#fbbf24", textDecoration: "none" }}>
                    {liveState.governance.actionable} awaiting decision →
                  </Link>
                ) : (
                  <span style={{ color: "#475569" }}>nothing awaiting decision</span>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 3 }}>
                Audit — <span style={{ color: "#475569" }}>{liveState.audit.state}</span>
              </div>
            </div>
          </div>
        )}

        {notifications.length > 0 && (
          <div style={{ marginTop: 16, padding: "12px 15px", background: "#2b2417", border: "1px solid #d97706", borderRadius: 9 }}>
            <div style={{ fontSize: 11, letterSpacing: 1.3, color: "#fcd34d", fontWeight: 700 }}>WORTH A LOOK</div>
            {notifications.map((n) => (
              <div key={n.id} style={{ fontSize: 13, color: "#fde68a", marginTop: 6, lineHeight: 1.5 }}>
                · {n.title} <span style={{ color: "#a16207" }}>(seen {n.occurrenceCount}×)</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 22, alignItems: "start" }}>
          {/* ---------- INTENDED ---------- */}
          <div>
            <SectionLabel>WHAT WAS SUPPOSED TO HAPPEN</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {live?.current && <SlotRow slot={live.current} tag="NOW" tagColor="#22c55e" />}
              {live?.concurrent?.map((s) => <SlotRow key={s.slotId} slot={s} tag="ALSO NOW" tagColor="#f59e0b" />)}
              {live?.next && <SlotRow slot={live.next} tag="NEXT" tagColor="#3b82f6" />}
              {live?.later?.map((s) => <SlotRow key={s.slotId} slot={s} />)}
              {live?.completed?.map((s) => <SlotRow key={s.slotId} slot={s} dim />)}
              {!live?.current && !live?.next && !live?.later?.length && !live?.completed?.length && (
                <Empty>Nothing scheduled for this day.</Empty>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 10, lineHeight: 1.55 }}>
              The timetable states intent. Whether something happened comes from the
              record on the right, never from the clock having passed.
            </div>
          </div>

          {/* ---------- ACTUAL ---------- */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <SectionLabel>WHAT ACTUALLY HAPPENED</SectionLabel>
              <button
                onClick={noteContext}
                disabled={busy}
                style={{ padding: "5px 11px", background: "#161b26", border: "1px solid #243044", borderRadius: 6, color: "#94a3b8", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit" }}
              >
                + note something
              </button>
            </div>

            {entries.length === 0 ? (
              <Empty>Nothing recorded on this day.</Empty>
            ) : (
              <div style={{ position: "relative", paddingLeft: 4 }}>
                {entries.map((e, i) => {
                  const st = style(e.eventType);
                  const prev = entries[i - 1];
                  const newTime = !prev || prev.time !== e.time;
                  return (
                    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "46px 18px 1fr", gap: 7, alignItems: "start" }}>
                      <div style={{ fontSize: 11, color: newTime ? "#94a3b8" : "transparent", fontVariantNumeric: "tabular-nums", paddingTop: 7, textAlign: "right" }}>
                        {e.time}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 7 }}>
                        <span style={{ color: st.color, fontSize: 11, lineHeight: 1 }}>{st.glyph}</span>
                        {i < entries.length - 1 && (
                          <span style={{ width: 1, flex: 1, minHeight: 16, background: "#1e2637", marginTop: 3 }} />
                        )}
                      </div>
                      <div style={{ paddingTop: 3, paddingBottom: 5 }}>
                        <div style={{ fontSize: 12.5, color: "#cbd5e1", lineHeight: 1.45 }}>{e.summary}</div>
                        <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>
                          {e.eventType.replace(/_/g, " ")}
                          {e.positionKey && ` · ${e.positionKey}`}
                          {e.actor !== "system" && ` · ${e.actor}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 11, color: "#475569", marginTop: 10, lineHeight: 1.55 }}>
              Raw observations in the order they occurred. Nothing here is an
              interpretation — that belongs to the audit.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 700, marginBottom: 10 }}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "13px 15px", background: "#0f1420", border: "1px dashed #243044", borderRadius: 8, color: "#64748b", fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function SlotRow({ slot, tag, tagColor, dim }: { slot: Slot; tag?: string; tagColor?: string; dim?: boolean }) {
  const cancelled = slot.runtimeStatus === "cancelled";
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: "52px 1fr auto", gap: 9, alignItems: "center",
        padding: "8px 11px", background: "#0f1420", border: "1px solid #1e2637",
        borderLeft: `3px solid ${tagColor ?? "#1e2637"}`, borderRadius: 7,
        opacity: dim ? 0.5 : cancelled ? 0.42 : 1,
      }}
    >
      <div style={{ fontSize: 11, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{slot.startTime}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, textDecoration: cancelled ? "line-through" : "none" }}>
          {slot.title}
        </div>
        {slot.override && (
          <div style={{ fontSize: 10.5, color: "#fca5a5", marginTop: 2 }}>
            {slot.override.exceptionType} — {slot.override.reason}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {slot.generatesSession && slot.courseId && (
          <Link
            href={`/college/class?courseId=${slot.courseId}&slotId=${slot.slotId}`}
            style={{ fontSize: 10.5, color: "#93c5fd", textDecoration: "none", fontWeight: 600 }}
          >
            OPEN
          </Link>
        )}
        {tag && (
          <span style={{ fontSize: 9.5, letterSpacing: 0.9, color: tagColor, fontWeight: 800 }}>{tag}</span>
        )}
      </div>
    </div>
  );
}
