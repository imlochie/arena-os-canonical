"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface Slot {
  slotId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  activityType: string;
  slotBehaviour: string;
  periodLabel?: string;
  periodKey?: string;
  periodId?: string | null;
  courseId?: string | null;
  courseCode?: string | null;
  icon?: string;
  items?: string[];
  runtimeStatus: string;
  needsConfiguration?: boolean;
  configurationNote?: string;
  generatesSession?: boolean;
  override?: { exceptionType: string; reason: string } | null;
}

interface LiveState {
  date: string;
  time: string;
  dayName: string;
  theme: string;
  current: Slot | null;
  concurrent: Slot[];
  next: Slot | null;
  previous: Slot | null;
  later: Slot[];
  completed: Slot[];
  note?: string;
}

interface Period {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  sequence: number;
  intent?: string;
}

const CATEGORY: Record<string, { bg: string; bd: string; fg: string; label: string }> = {
  academic: { bg: "#1e293b", bd: "#3b82f6", fg: "#93c5fd", label: "Academic" },
  creative: { bg: "#2a1e35", bd: "#a855f7", fg: "#d8b4fe", label: "Creative" },
  administrative: { bg: "#2b2417", bd: "#d97706", fg: "#fcd34d", label: "Admin" },
  health: { bg: "#13291f", bd: "#10b981", fg: "#6ee7b7", label: "Health" },
  relationship: { bg: "#301c26", bd: "#ec4899", fg: "#f9a8d4", label: "Relationship" },
  household: { bg: "#26241c", bd: "#a3a380", fg: "#d5d5a8", label: "Household" },
  adventure: { bg: "#1c2a30", bd: "#06b6d4", fg: "#67e8f9", label: "Adventure" },
  recovery: { bg: "#22202e", bd: "#818cf8", fg: "#c7d2fe", label: "Recovery" },
  entertainment: { bg: "#2d1f2b", bd: "#f472b6", fg: "#fbcfe8", label: "Entertainment" },
  routine: { bg: "#1f2226", bd: "#64748b", fg: "#cbd5e1", label: "Routine" },
};

const cat = (t: string) => CATEGORY[t] ?? CATEGORY.routine;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function TimetablePage() {
  const [view, setView] = useState<"day" | "week">("day");
  const [live, setLive] = useState<LiveState | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [week, setWeek] = useState<{ days: { date: string; dayName: string; theme: string; slots: Slot[] }[]; themes: { dayOfWeek: number; theme: string; subtitle?: string }[] } | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");

  const loadDay = useCallback(async () => {
    const r = await fetch("/api/college/timetable-live");
    const d = await r.json();
    setLive(d.live ?? null);
    setPeriods(d.periods ?? []);
    setConfigured(d.configured !== false);
    setLoading(false);
  }, []);

  const loadWeek = useCallback(async () => {
    const r = await fetch("/api/college/timetable-live?view=week");
    const d = await r.json();
    setWeek({ days: d.days ?? [], themes: d.themes ?? [] });
    setPeriods(d.periods ?? []);
    setConfigured(d.configured !== false);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      setLoading(true);
      if (view === "day") await loadDay();
      else await loadWeek();
    })();
    return () => {
      cancelled = true;
    };
  }, [view, loadDay, loadWeek]);

  // Re-read the application clock every 60s. The clock is the source of
  // position — never conversational memory.
  useEffect(() => {
    if (view !== "day") return;
    const t = setInterval(() => void loadDay(), 60_000);
    return () => clearInterval(t);
  }, [view, loadDay]);

  async function importReference() {
    setBusy(true);
    await fetch("/api/college/timetable-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "import_reference",
        reason: "Initial import from the Student Timetable design reference.",
      }),
    });
    setBusy(false);
    view === "day" ? await loadDay() : await loadWeek();
  }

  async function markStatus(slot: Slot, status: string) {
    const evidence = window.prompt(
      `What is the evidence that this slot was ${status}?\n\nThe clock passing the end time is not evidence.`
    );
    if (!evidence) return;
    setBusy(true);
    const r = await fetch("/api/college/timetable-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", slotId: slot.slotId, date: live?.date, status, evidence }),
    });
    const d = await r.json();
    setFlash(d.error ?? `Recorded: ${status}`);
    setBusy(false);
    setSelected(null);
    await loadDay();
  }

  async function cancelToday(slot: Slot) {
    const reason = window.prompt("Why is this not happening today?\n\nThis changes today only — the recurring timetable is untouched.");
    if (!reason) return;
    setBusy(true);
    await fetch("/api/college/timetable-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "override",
        slotId: slot.slotId,
        date: live?.date,
        exceptionType: "cancelled",
        reason,
      }),
    });
    setFlash("Today only. The recurring timetable is unchanged.");
    setBusy(false);
    setSelected(null);
    await loadDay();
  }

  if (loading) {
    return <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui" }}>Reading the timetable…</div>;
  }

  if (!configured) {
    return (
      <div style={{ padding: 40, fontFamily: "system-ui", color: "#e2e8f0", maxWidth: 640 }}>
        <h1 style={{ fontSize: 22 }}>No timetable configured</h1>
        <p style={{ color: "#94a3b8", lineHeight: 1.6 }}>
          The College has no active timetable version. You can import the structure from the
          Student Timetable design reference as a starting configuration — ambiguous values will be
          flagged for you to decide, not guessed.
        </p>
        <button
          onClick={importReference}
          disabled={busy}
          style={{
            marginTop: 16, padding: "10px 18px", background: "#2563eb", color: "white",
            border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
          }}
        >
          {busy ? "Importing…" : "Import reference timetable"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0b0f17", minHeight: "100vh", color: "#e2e8f0" }}>
      <div style={{ maxWidth: view === "week" ? 1500 : 860, margin: "0 auto", padding: "28px 22px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <div>
            <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>← College</Link>
            <h1 style={{ fontSize: 24, margin: "6px 0 0", letterSpacing: -0.4 }}>Timetable</h1>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(["day", "week"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: "7px 16px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600,
                  background: view === v ? "#2563eb" : "#161b26",
                  color: view === v ? "white" : "#94a3b8",
                  border: `1px solid ${view === v ? "#2563eb" : "#243044"}`,
                }}
              >
                {v === "day" ? "Today" : "Week"}
              </button>
            ))}
          </div>
        </div>

        {flash && (
          <div style={{ padding: "10px 14px", background: "#14243a", border: "1px solid #2563eb", borderRadius: 8, fontSize: 13, marginBottom: 16, color: "#bfdbfe" }}>
            {flash} <button onClick={() => setFlash("")} style={{ float: "right", background: "none", border: "none", color: "#64748b", cursor: "pointer" }}>✕</button>
          </div>
        )}

        {view === "day" && live && <DayView live={live} onSelect={setSelected} />}
        {view === "week" && week && <WeekGrid week={week} periods={periods} onSelect={setSelected} />}
      </div>

      {selected && (
        <SlotDetail
          slot={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onStatus={markStatus}
          onCancel={cancelToday}
        />
      )}
    </div>
  );
}

function DayView({ live, onSelect }: { live: LiveState; onSelect: (s: Slot) => void }) {
  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#64748b", letterSpacing: 1.6, fontWeight: 700 }}>
          TODAY · {live.date}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 30, margin: 0, letterSpacing: -0.8 }}>
            {live.dayName.toUpperCase()}
            {live.theme && <span style={{ color: "#f59e0b" }}> — {live.theme}</span>}
          </h2>
          <span style={{ fontSize: 22, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{live.time}</span>
        </div>
      </div>

      <Section label="CURRENT" accent="#22c55e">
        {live.current ? (
          <SlotCard slot={live.current} big onSelect={onSelect} />
        ) : (
          <Empty text="Nothing scheduled at this moment." />
        )}
        {live.concurrent?.length > 0 && (
          <>
            {live.concurrent.map((s) => <SlotCard key={s.slotId} slot={s} big onSelect={onSelect} />)}
            {live.note && (
              <div style={{ fontSize: 12, color: "#fcd34d", padding: "8px 12px", background: "#2b2417", borderRadius: 7, marginTop: 8, lineHeight: 1.5 }}>
                ⚠ {live.note}
              </div>
            )}
          </>
        )}
      </Section>

      <Section label="UP NEXT" accent="#3b82f6">
        {live.next ? <SlotCard slot={live.next} onSelect={onSelect} /> : <Empty text="Nothing further scheduled today." />}
      </Section>

      {live.later.length > 0 && (
        <Section label="LATER" accent="#475569">
          {live.later.map((s) => <SlotCard key={s.slotId} slot={s} onSelect={onSelect} />)}
        </Section>
      )}

      {live.completed.length > 0 && (
        <Section label="EARLIER TODAY" accent="#334155">
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>
            These slots have passed on the clock. That is not the same as having happened —
            status stays open until there is evidence.
          </div>
          {live.completed.map((s) => <SlotCard key={s.slotId} slot={s} dim onSelect={onSelect} />)}
        </Section>
      )}
    </>
  );
}

function Section({ label, accent, children }: { label: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.8, color: accent, marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: "14px 16px", background: "#0f1420", border: "1px dashed #243044", borderRadius: 9, color: "#64748b", fontSize: 13 }}>
      {text}
    </div>
  );
}

function SlotCard({ slot, big, dim, onSelect }: { slot: Slot; big?: boolean; dim?: boolean; onSelect: (s: Slot) => void }) {
  const c = cat(slot.activityType);
  const cancelled = slot.runtimeStatus === "cancelled";
  return (
    <button
      onClick={() => onSelect(slot)}
      style={{
        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
        background: c.bg, border: `1px solid ${c.bd}`, borderLeft: `4px solid ${c.bd}`,
        borderRadius: 9, padding: big ? "16px 18px" : "11px 14px",
        opacity: dim ? 0.52 : cancelled ? 0.45 : 1,
        textDecoration: cancelled ? "line-through" : "none",
        fontFamily: "inherit", color: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: big ? 19 : 15, fontWeight: 650, letterSpacing: -0.2 }}>
            {slot.icon ? `${slot.icon} ` : ""}{slot.title}
          </div>
          {slot.periodLabel && (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, letterSpacing: 0.4 }}>
              {slot.periodLabel.toUpperCase()}
            </div>
          )}
          {slot.description && big && (
            <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6, lineHeight: 1.5 }}>{slot.description}</div>
          )}
          {slot.override && (
            <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 5 }}>
              {slot.override.exceptionType.toUpperCase()} — {slot.override.reason}
            </div>
          )}
          {slot.needsConfiguration && (
            <div style={{ fontSize: 11, color: "#fcd34d", marginTop: 5 }}>⚙ Needs configuration</div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: big ? 15 : 13, fontVariantNumeric: "tabular-nums", color: c.fg, fontWeight: 600 }}>
            {slot.startTime}
          </div>
          <div style={{ fontSize: 11, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{slot.endTime}</div>
        </div>
      </div>
      {big && slot.generatesSession && slot.courseId && (
        <div style={{ marginTop: 12, fontSize: 12, color: "#93c5fd", fontWeight: 600 }}>▶ Tap to open class</div>
      )}
    </button>
  );
}

function WeekGrid({
  week,
  periods,
  onSelect,
}: {
  week: { days: { date: string; dayName: string; theme: string; slots: Slot[] }[]; themes: { dayOfWeek: number; theme: string; subtitle?: string }[] };
  periods: Period[];
  onSelect: (s: Slot) => void;
}) {
  const ordered = [...periods].sort((a, b) => a.sequence - b.sequence);
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: `130px repeat(7, minmax(150px, 1fr))`, gap: 5, minWidth: 1180 }}>
        <div />
        {week.days.map((d, i) => {
          const theme = week.themes.find((t) => t.dayOfWeek === i + 1);
          return (
            <div key={d.date} style={{ textAlign: "center", padding: "9px 4px", background: "#111726", borderRadius: 7, border: "1px solid #1e2637" }}>
              <div style={{ fontSize: 12, fontWeight: 750, letterSpacing: 0.3 }}>{DAYS[i].slice(0, 3).toUpperCase()}</div>
              <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 700, marginTop: 2 }}>{theme?.theme ?? ""}</div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{d.date.slice(5)}</div>
            </div>
          );
        })}

        {ordered.map((p) => (
          <PeriodRow key={p.id} period={p} week={week} onSelect={onSelect} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20, fontSize: 11, color: "#64748b" }}>
        {Object.entries(CATEGORY).map(([k, v]) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, background: v.bg, border: `1px solid ${v.bd}`, borderRadius: 3, display: "inline-block" }} />
            {v.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PeriodRow({
  period,
  week,
  onSelect,
}: {
  period: Period;
  week: { days: { date: string; slots: Slot[] }[] };
  onSelect: (s: Slot) => void;
}) {
  return (
    <>
      <div style={{ padding: "9px 10px", background: "#0f1420", borderRadius: 7, border: "1px solid #1e2637" }}>
        <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.3, lineHeight: 1.3 }}>{period.label}</div>
        <div style={{ fontSize: 10, color: "#475569", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
          {period.startTime}–{period.endTime || "…"}
        </div>
      </div>
      {week.days.map((d) => {
        const slots = d.slots.filter((s) => s.periodId === period.id);
        return (
          <div key={d.date + period.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {slots.length === 0 && (
              <div style={{ minHeight: 40, background: "#0c101a", borderRadius: 6, border: "1px dashed #19202e" }} />
            )}
            {slots.map((s) => {
              const c = cat(s.activityType);
              return (
                <button
                  key={s.slotId}
                  onClick={() => onSelect(s)}
                  style={{
                    background: c.bg, border: `1px solid ${c.bd}`, borderLeft: `3px solid ${c.bd}`,
                    borderRadius: 6, padding: "7px 8px", cursor: "pointer", textAlign: "left",
                    fontFamily: "inherit", color: "inherit", minHeight: 40,
                    opacity: s.runtimeStatus === "cancelled" ? 0.4 : 1,
                  }}
                >
                  <div style={{ fontSize: 11.5, fontWeight: 620, lineHeight: 1.25 }}>
                    {s.icon ? `${s.icon} ` : ""}{s.title}
                  </div>
                  <div style={{ fontSize: 9.5, color: "#64748b", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                    {s.startTime}
                  </div>
                  {s.needsConfiguration && <div style={{ fontSize: 9.5, color: "#fcd34d", marginTop: 2 }}>⚙</div>}
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function SlotDetail({
  slot,
  busy,
  onClose,
  onStatus,
  onCancel,
}: {
  slot: Slot;
  busy: boolean;
  onClose: () => void;
  onStatus: (s: Slot, status: string) => void;
  onCancel: (s: Slot) => void;
}) {
  const c = cat(slot.activityType);
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(3,6,12,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#0f1420", border: `1px solid ${c.bd}`, borderRadius: 13, padding: 24, maxWidth: 520, width: "100%", maxHeight: "86vh", overflowY: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: c.fg, letterSpacing: 1.3, fontWeight: 700 }}>
              {(slot.periodLabel || c.label).toUpperCase()}
            </div>
            <h3 style={{ margin: "5px 0 0", fontSize: 21, letterSpacing: -0.3 }}>
              {slot.icon ? `${slot.icon} ` : ""}{slot.title}
            </h3>
            <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              {slot.startTime} – {slot.endTime}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", fontSize: 21, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {slot.description && (
          <p style={{ color: "#cbd5e1", fontSize: 14, lineHeight: 1.6, marginTop: 14 }}>{slot.description}</p>
        )}

        {slot.items && slot.items.length > 0 && (
          <ul style={{ margin: "12px 0 0", paddingLeft: 18, color: "#94a3b8", fontSize: 13, lineHeight: 1.75 }}>
            {slot.items.map((it, i) => <li key={i}>{it}</li>)}
          </ul>
        )}

        {slot.needsConfiguration && slot.configurationNote && (
          <div style={{ marginTop: 14, padding: "11px 13px", background: "#2b2417", border: "1px solid #d97706", borderRadius: 8, fontSize: 12.5, color: "#fcd34d", lineHeight: 1.55 }}>
            <strong>Needs configuration.</strong> {slot.configurationNote}
          </div>
        )}

        {slot.override && (
          <div style={{ marginTop: 14, padding: "11px 13px", background: "#2a1a1a", border: "1px solid #dc2626", borderRadius: 8, fontSize: 12.5, color: "#fca5a5", lineHeight: 1.55 }}>
            <strong>{slot.override.exceptionType.toUpperCase()} on this date.</strong> {slot.override.reason}
            <div style={{ color: "#94a3b8", marginTop: 5 }}>The recurring timetable is unchanged.</div>
          </div>
        )}

        <div style={{ marginTop: 16, display: "flex", gap: 14, fontSize: 11.5, color: "#64748b", flexWrap: "wrap" }}>
          <span>Type: <strong style={{ color: c.fg }}>{c.label}</strong></span>
          <span>Behaviour: <strong style={{ color: "#94a3b8" }}>{slot.slotBehaviour}</strong></span>
          <span>Status: <strong style={{ color: "#94a3b8" }}>{slot.runtimeStatus}</strong></span>
        </div>

        {slot.generatesSession && slot.courseId && (
          <Link
            href={`/college/class?courseId=${slot.courseId}&slotId=${slot.slotId}`}
            style={{
              display: "block", marginTop: 18, padding: "12px 16px", background: "#2563eb", color: "white",
              borderRadius: 9, textAlign: "center", fontWeight: 650, fontSize: 14, textDecoration: "none",
            }}
          >
            ▶ OPEN CLASS
          </Link>
        )}
        {slot.generatesSession && !slot.courseId && (
          <div style={{ marginTop: 18, padding: "11px 13px", background: "#1a2030", borderRadius: 8, fontSize: 12.5, color: "#94a3b8", lineHeight: 1.55 }}>
            This is an academic slot with no course attached yet. Attach a course to launch a class from here.
          </div>
        )}

        <div style={{ marginTop: 18, borderTop: "1px solid #1e2637", paddingTop: 15 }}>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 9, letterSpacing: 0.5 }}>RECORD WHAT ACTUALLY HAPPENED</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {["completed", "missed", "deviated"].map((s) => (
              <button
                key={s}
                disabled={busy}
                onClick={() => onStatus(slot, s)}
                style={{ padding: "7px 13px", background: "#161b26", border: "1px solid #243044", borderRadius: 7, color: "#cbd5e1", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}
              >
                {s}
              </button>
            ))}
            <button
              disabled={busy}
              onClick={() => onCancel(slot)}
              style={{ padding: "7px 13px", background: "#2a1a1a", border: "1px solid #7f1d1d", borderRadius: 7, color: "#fca5a5", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}
            >
              not today
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 9, lineHeight: 1.5 }}>
            Each of these requires a reason or evidence. The clock passing is never treated as proof
            that something happened.
          </div>
        </div>
      </div>
    </div>
  );
}
