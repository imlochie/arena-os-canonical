// ============================================================================
// Lochie Life College — live runtime state (SERVER ONLY)
// ============================================================================
// LAYER 6 §24.
//
// The single answer to "what is the College doing right now?". Everything here
// comes from the application clock and persisted records — never from
// conversational memory, and never inferred from the clock alone.
//
// The most important line in this file is the one that does NOT exist: there
// is no rule that says a slot whose end time has passed is complete. Completion
// requires session evidence. A class that was scheduled and never opened is
// UNKNOWN, not finished, and the difference is the whole point.
// ============================================================================

import { db } from "@/db";
import { collegeSessions } from "@/db/college";
import { and, desc, eq, sql } from "drizzle-orm";
import { brisbaneLongDate, brisbaneNow, dayName } from "./time";
import { livePosition } from "./timetable";
import { effectivePolicies } from "./attention-resolver";
import { currentAttention } from "./orchestrator";
import { pendingNotifications } from "./ledger";
import { governanceQueue } from "./governance";
import { resolveProtocol } from "./protocol";
import { getFacultyPosition } from "./faculty";

export interface LiveFacultyState {
  positionKey: string;
  memberName: string;
  state: string;
  detail: string;
}

export interface LiveCollegeState {
  clock: { longDate: string; time: string; dayName: string; timezone: string };
  current: {
    kind: "class" | "activity" | "none";
    title: string;
    startTime: string;
    endTime: string;
    activityType: string;
    sessionId: string | null;
    sessionStatus: string | null;
    /** Explicit: the clock passing does not close a class. */
    completionEvidence: string;
  };
  next: { title: string; startTime: string; inMinutes: number | null } | null;
  faculty: LiveFacultyState[];
  timetable: { state: string; detail: string };
  alerts: Array<{ severity: string; title: string; detail: string }>;
  governance: { actionable: number; informational: number; note: string };
  audit: { state: string; detail: string };
  note: string;
}

/**
 * `at` resolves the live state AS IF it were another moment. It changes no
 * record — it re-asks the question against a different clock, the same
 * discipline as Layer 6 replay. Without it, Layer 7's `?at=` would move
 * temporal state while leaving the timetable stuck on the real day, which
 * would be a briefing that quietly contradicts itself.
 */
export async function liveCollegeState(at?: Date): Promise<LiveCollegeState> {
  const now = brisbaneNow(at);
  const hhmm = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  const nowMinutes = now.hour * 60 + now.minute;

  const position = await livePosition(now.isoDate, at);

  // ---- IS A SESSION ACTUALLY RUNNING? ------------------------------------
  // Running means a session row says so. Not "the clock is between two times".
  const [running] = await db
    .select()
    .from(collegeSessions)
    .where(and(eq(collegeSessions.status, "running"), eq(collegeSessions.observedDate, now.isoDate)))
    .orderBy(desc(collegeSessions.createdAt))
    .limit(1);

  const slot = position.current;
  let current: LiveCollegeState["current"];

  if (running) {
    current = {
      kind: "class",
      title: running.title,
      startTime: running.scheduledTime || slot?.startTime || "",
      endTime: slot?.endTime ?? "",
      activityType: slot?.activityType ?? "academic",
      sessionId: running.id,
      sessionStatus: running.status,
      completionEvidence: "A session is open. It closes when the runtime closes it, not when the clock passes.",
    };
  } else if (slot) {
    current = {
      kind: "activity",
      title: slot.title,
      startTime: slot.startTime,
      endTime: slot.endTime,
      activityType: slot.activityType,
      sessionId: slot.sessionId,
      sessionStatus: null,
      completionEvidence: slot.sessionId
        ? "A session exists for this slot."
        : "Scheduled now, but no session has been opened. This is not a failure — it is simply unopened.",
    };
  } else {
    current = {
      kind: "none",
      title: "No active class",
      startTime: "",
      endTime: "",
      activityType: "",
      sessionId: null,
      sessionStatus: null,
      completionEvidence: "Nothing is scheduled at this moment.",
    };
  }

  // ---- NEXT ---------------------------------------------------------------
  let next: LiveCollegeState["next"] = null;
  if (position.next) {
    const [h, m] = position.next.startTime.split(":").map(Number);
    const startMinutes = Number.isFinite(h) ? h * 60 + (m || 0) : null;
    next = {
      title: position.next.title,
      startTime: position.next.startTime,
      inMinutes: startMinutes !== null ? startMinutes - nowMinutes : null,
    };
  }

  // ---- FACULTY ------------------------------------------------------------
  const faculty: LiveFacultyState[] = [];
  let attentionRows = 0;
  if (running) {
    // A live session has real attention states.
    const attention = await currentAttention(running.id);
    attentionRows = attention.length;
    for (const a of attention) {
      faculty.push({
        positionKey: a.positionKey,
        memberName: a.name,
        state: a.spoke ? "speaking" : a.state,
        detail: a.reason,
      });
    }
  }
  if (!faculty.length) {
    // Either no class is running, or one is running with no attention on
    // record. Report the standing configuration rather than an empty list —
    // "no faculty" would be false, and the College does have faculty.
    const protocol = await resolveProtocol(slot?.courseId ?? null, slot?.sessionKind ?? "lesson");
    const policies = await effectivePolicies({
      courseId: slot?.courseId ?? null,
      sessionKind: slot?.sessionKind ?? "lesson",
      positions: protocol.positions.map((p) => p.positionKey),
    });
    for (const [key, policy] of policies) {
      const pos = getFacultyPosition(key);
      faculty.push({
        positionKey: key,
        memberName: policy.memberName || pos?.name || key,
        state: "dormant",
        detail: pos?.participatesInClass
          ? `Opens ${policy.defaultState} when a class begins.`
          : "Administration. Does not attend class.",
      });
    }
  }

  // ---- TIMETABLE STATE ----------------------------------------------------
  const deviated = [...position.completed, ...position.later].filter(
    (s) => s.runtimeStatus === "deviated" || s.override
  );
  const timetable = deviated.length
    ? {
        state: "modified",
        detail: `${deviated.length} slot(s) today carry an override or deviation. The recurring template is unchanged.`,
      }
    : { state: "operating normally", detail: "No overrides or deviations today." };

  // ---- ALERTS -------------------------------------------------------------
  const notifications = await pendingNotifications();
  const alerts = notifications.map((n) => ({
    severity: n.severity,
    title: n.title,
    detail: n.body,
  }));

  // A session still open past the end of its slot is an operational fact worth
  // surfacing. It is NOT a failure and must not be described as one — the
  // class may simply be running long, or it may have been left open. The
  // College reports the condition and lets the founder judge. Note that it
  // still does not close the session: completion requires evidence.
  if (running && slot && slot.endTime) {
    const [eh, em] = slot.endTime.split(":").map(Number);
    const endMinutes = Number.isFinite(eh) ? eh * 60 + (em || 0) : null;
    if (endMinutes !== null && nowMinutes > endMinutes) {
      alerts.push({
        severity: "low",
        title: "A session is still open past its scheduled end",
        detail: `"${running.title}" was scheduled to end at ${slot.endTime} and is still marked running. This is recorded, not corrected — the clock passing does not close a class. Close it when it actually ended.`,
      });
    }
  }
  if (running && !attentionRows) {
    alerts.push({
      severity: "low",
      title: "An open session has no faculty attention recorded",
      detail: `"${running.title}" is marked running but no faculty attention was ever recorded against it. It was most likely opened without being taught.`,
    });
  }

  // ---- GOVERNANCE + AUDIT -------------------------------------------------
  const queue = await governanceQueue();
  const actionable = queue.items.filter((i) => !i.informationalOnly).length;
  const informational = queue.items.filter((i) => i.informationalOnly).length;

  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(collegeSessions)
    .where(sql`${collegeSessions.createdAt} > now() - interval '7 days'`);

  const audit = {
    state: informational ? "review signal present" : "no immediate review required",
    detail: informational
      ? `${informational} audit review signal(s) are waiting. A review signal is a request to look, not a request to change.`
      : `${recent} session(s) in the last 7 days. Nothing indicates a review is needed.`,
  };

  return {
    clock: {
      longDate: brisbaneLongDate(),
      time: hhmm,
      dayName: dayName(now.dayOfWeek),
      timezone: "Australia/Brisbane",
    },
    current,
    next,
    faculty,
    timetable,
    alerts,
    governance: { actionable, informational, note: queue.note },
    audit,
    note: "Resolved from the application clock and persisted records. Completion is never inferred from the clock passing an end time.",
  };
}

/** The compact printed form from the brief (§24). */
export function renderLiveState(s: LiveCollegeState): string {
  const L: string[] = [];
  L.push("COLLEGE");
  L.push(s.clock.longDate);
  L.push(`${s.clock.time} Brisbane`);
  L.push("");
  L.push("CURRENT:");
  L.push(
    s.current.kind === "none"
      ? "No active class"
      : `${s.current.title}${s.current.startTime ? ` (${s.current.startTime}${s.current.endTime ? `–${s.current.endTime}` : ""})` : ""}`
  );
  L.push("");
  if (s.next) {
    L.push("NEXT:");
    L.push(s.next.title);
    L.push(s.next.startTime + (s.next.inMinutes !== null ? `  (in ${s.next.inMinutes} min)` : ""));
    L.push("");
  }
  L.push("FACULTY:");
  if (!s.faculty.length) L.push("  (none configured)");
  for (const f of s.faculty) L.push(`  ${f.memberName} — ${f.state}`);
  L.push("");
  L.push(`TIMETABLE:  ${s.timetable.state}`);
  L.push(`ALERTS:     ${s.alerts.length ? s.alerts.map((a) => a.title).join("; ") : "None"}`);
  L.push(`GOVERNANCE: ${s.governance.actionable ? `${s.governance.actionable} awaiting decision` : "Nothing awaiting decision"}`);
  L.push(`AUDIT:      ${s.audit.state}`);
  return L.join("\n");
}
