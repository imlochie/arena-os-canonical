import "server-only";

import { db } from "@/db";
import {
  collegeEventLedger,
  collegeNotificationPolicy,
  collegeNotifications,
} from "@/db/college";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { brisbaneNow } from "./time";

/**
 * THE COLLEGE EVENT LEDGER
 *
 * A structured institutional timeline of what actually happened, in order.
 *
 * This is deliberately NOT a copy of every table. It is the connective tissue
 * between the timetable (what was supposed to happen), the session (what
 * happened), real-world context (why it differed) and the audit (what it means
 * over time). Without it, the audit has to reconstruct history by joining
 * scattered tables and guessing at ordering.
 *
 * Two rules keep it honest:
 *
 *   1. The ledger records OBSERVATIONS, never interpretations. "Class shortened"
 *      is a ledger event. "Thursday is inefficient" is not — that is an audit
 *      conclusion drawn from many events plus context.
 *
 *   2. Entries are append-only. Nothing in here is edited or deleted. A mistake
 *      is corrected by appending a correcting entry, exactly as the rest of the
 *      College treats history.
 */

export const LEDGER_EVENTS = [
  "timetable_slot_active",
  "class_opened",
  "faculty_activated",
  "faculty_watching",
  "faculty_consulted",
  "faculty_deferred",
  "faculty_escalated",
  // §22. Interruption is a three-part record: asking is not the same as being
  // allowed, and a refusal is as much a fact as an acceptance.
  "faculty_interruption_requested",
  "faculty_interruption_accepted",
  "faculty_interruption_rejected",
  // A member that attended and said nothing is a recorded outcome, not an
  // absence of data. Distinct from faculty_watching, which is per-event.
  "faculty_silent",
  "memory_recalled",
  "observer_noted",
  "objective_demonstrated",
  "goal_addressed",
  "real_world_interruption",
  "real_world_context_added",
  "class_shortened",
  "class_completed",
  "session_closed",
  "timetable_override",
  "curriculum_change",
  "decision_recorded",
  "memory_recorded",
  "memory_promoted",
  "audit_recorded",
  // Proposing a record and filing one are different institutional acts.
  "record_proposed",
  "record_filed",
  // §L8. Commitments are their own vocabulary: making, closing and reviewing
  // are three different acts, and a review that changes nothing is still an
  // event worth having in the record.
  "commitment_made",
  "commitment_closed",
  "commitment_reviewed",
  // §L7 correction. `/api/college/external` has been writing this event since
  // Layer 7 while the vocabulary never declared it — `record()` accepted the
  // string, so it wrote cleanly and silently. An event type the ledger cannot
  // name is an event type nothing can filter, audit, or reason about, which is
  // precisely the "unnamed truth" failure the ledger exists to prevent.
  // Declared here rather than removed from the routes: external academic
  // events are real, and the briefing already reads them.
  "external_academic_event",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENTS)[number] | string;

export type Severity = "informational" | "low" | "medium" | "high" | "critical";

export interface LedgerInput {
  eventType: LedgerEventType;
  summary: string;
  detail?: Record<string, unknown>;
  sessionId?: string | null;
  slotId?: string | null;
  courseId?: string | null;
  memberId?: string | null;
  positionKey?: string;
  curriculumVersionId?: string | null;
  timetableVersionId?: string | null;
  actor?: string;
  severity?: Severity;
  /** Override the clock — used only when back-recording a known past event. */
  date?: string;
  time?: string;
}

/**
 * Append one entry. Never throws into the caller's path: a ledger failure must
 * not take down a class. A dropped observation is bad; a crashed lesson is
 * worse.
 */
export async function record(input: LedgerInput): Promise<string | null> {
  try {
    const now = brisbaneNow();
    const date = input.date ?? now.isoDate;
    const time =
      input.time ??
      `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(collegeEventLedger)
      .where(eq(collegeEventLedger.date, date));

    const [row] = await db
      .insert(collegeEventLedger)
      .values({
        date,
        time,
        sequence: Number(count) + 1,
        eventType: String(input.eventType),
        summary: input.summary.slice(0, 2000),
        detail: JSON.stringify(input.detail ?? {}).slice(0, 8000),
        sessionId: input.sessionId ?? null,
        slotId: input.slotId ?? null,
        courseId: input.courseId ?? null,
        memberId: input.memberId ?? null,
        positionKey: input.positionKey ?? "",
        curriculumVersionId: input.curriculumVersionId ?? null,
        timetableVersionId: input.timetableVersionId ?? null,
        actor: input.actor ?? "system",
        severity: input.severity ?? "informational",
      })
      .returning();

    // Notification consideration is separate from recording. Most events are
    // recorded and never surfaced.
    await considerNotification(row.id, input);
    return row.id;
  } catch (e) {
    console.error("ledger append failed", e);
    return null;
  }
}

/** Append several entries in order. */
export async function recordMany(inputs: LedgerInput[]): Promise<void> {
  for (const i of inputs) await record(i);
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

export interface LedgerDay {
  date: string;
  entries: Array<{
    id: string;
    time: string;
    sequence: number;
    eventType: string;
    summary: string;
    detail: Record<string, unknown>;
    positionKey: string;
    memberId: string | null;
    actor: string;
    severity: string;
    sessionId: string | null;
    slotId: string | null;
  }>;
}

/** The institutional timeline for one day, in order. */
export async function day(dateIso: string): Promise<LedgerDay> {
  const rows = await db
    .select()
    .from(collegeEventLedger)
    .where(eq(collegeEventLedger.date, dateIso))
    .orderBy(asc(collegeEventLedger.sequence));

  return {
    date: dateIso,
    entries: rows.map((r) => ({
      id: r.id,
      time: r.time,
      sequence: r.sequence,
      eventType: r.eventType,
      summary: r.summary,
      detail: safeParse(r.detail),
      positionKey: r.positionKey,
      memberId: r.memberId,
      actor: r.actor,
      severity: r.severity,
      sessionId: r.sessionId,
      slotId: r.slotId,
    })),
  };
}

/** Ledger entries in a window, optionally filtered — the audit's data source. */
export async function range(input: {
  from: string;
  to: string;
  eventTypes?: string[];
  slotId?: string | null;
  courseId?: string | null;
  sessionId?: string | null;
}) {
  const where = [gte(collegeEventLedger.date, input.from), lte(collegeEventLedger.date, input.to)];
  if (input.slotId) where.push(eq(collegeEventLedger.slotId, input.slotId));
  if (input.courseId) where.push(eq(collegeEventLedger.courseId, input.courseId));
  if (input.sessionId) where.push(eq(collegeEventLedger.sessionId, input.sessionId));

  const rows = await db
    .select()
    .from(collegeEventLedger)
    .where(and(...where))
    .orderBy(asc(collegeEventLedger.date), asc(collegeEventLedger.sequence));

  return input.eventTypes?.length
    ? rows.filter((r) => input.eventTypes!.includes(r.eventType))
    : rows;
}

/** Everything recorded for one session, in order. */
export async function forSession(sessionId: string) {
  return db
    .select()
    .from(collegeEventLedger)
    .where(eq(collegeEventLedger.sessionId, sessionId))
    .orderBy(asc(collegeEventLedger.occurredAt));
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Notifications — derived, suppressible, and quiet by default
// ---------------------------------------------------------------------------

/**
 * Default notification posture. Almost everything is recorded silently.
 *
 * A single missed class is informational and must NOT interrupt the founder.
 * Only a genuine institutional conflict is allowed to be loud, and even then
 * only after it has been seen more than once.
 */
const DEFAULT_POLICY: Record<string, { severity: Severity; occurrences: number; notify: boolean }> =
  {
    real_world_interruption: { severity: "informational", occurrences: 99, notify: false },
    class_shortened: { severity: "informational", occurrences: 99, notify: false },
    class_completed: { severity: "informational", occurrences: 99, notify: false },
    session_closed: { severity: "informational", occurrences: 99, notify: false },
    faculty_activated: { severity: "informational", occurrences: 99, notify: false },
    faculty_deferred: { severity: "informational", occurrences: 99, notify: false },
    timetable_override: { severity: "low", occurrences: 99, notify: false },
    // Repetition is what makes something worth raising — and even then it is a
    // question to consider, never an instruction to change anything.
    unexplained_deviation: { severity: "medium", occurrences: 3, notify: true },
    mandatory_faculty_missing: { severity: "high", occurrences: 1, notify: true },
    institutional_conflict: { severity: "high", occurrences: 1, notify: true },
  };

async function considerNotification(eventId: string, input: LedgerInput) {
  const key = String(input.eventType);
  const [configured] = await db
    .select()
    .from(collegeNotificationPolicy)
    .where(eq(collegeNotificationPolicy.eventType, key))
    .limit(1);

  const policy = configured
    ? {
        severity: configured.severity as Severity,
        occurrences: configured.occurrencesBeforeSurfacing,
        notify: configured.notify,
      }
    : DEFAULT_POLICY[key];

  // Unknown event types are recorded and stay silent. Silence is the default.
  if (!policy || !policy.notify) return;

  const notificationKey = `${key}:${input.slotId ?? input.courseId ?? input.sessionId ?? "college"}`;
  const [existing] = await db
    .select()
    .from(collegeNotifications)
    .where(eq(collegeNotifications.notificationKey, notificationKey))
    .limit(1);

  const today = brisbaneNow().isoDate;

  if (existing) {
    // Respect an active suppression — a settled question is not re-raised.
    if (existing.suppressedUntil && existing.suppressedUntil > today) {
      await db
        .update(collegeNotifications)
        .set({ occurrenceCount: existing.occurrenceCount + 1, lastSeenAt: new Date() })
        .where(eq(collegeNotifications.id, existing.id));
      return;
    }
    const next = existing.occurrenceCount + 1;
    await db
      .update(collegeNotifications)
      .set({
        occurrenceCount: next,
        lastSeenAt: new Date(),
        status: next >= policy.occurrences ? "pending" : existing.status,
      })
      .where(eq(collegeNotifications.id, existing.id));
    return;
  }

  await db.insert(collegeNotifications).values({
    notificationKey,
    severity: policy.severity,
    title: input.summary.slice(0, 200),
    body: JSON.stringify(input.detail ?? {}).slice(0, 2000),
    sourceEventId: eventId,
    scopeType: input.slotId ? "slot" : input.courseId ? "course" : "college",
    scopeId: input.slotId ?? input.courseId ?? null,
    occurrenceCount: 1,
    // Below the surfacing threshold it exists but is not shown.
    status: policy.occurrences <= 1 ? "pending" : "suppressed",
  });
}

/** Notifications the founder should actually see right now. */
export async function pendingNotifications() {
  const today = brisbaneNow().isoDate;
  const rows = await db
    .select()
    .from(collegeNotifications)
    .where(eq(collegeNotifications.status, "pending"))
    .orderBy(desc(collegeNotifications.lastSeenAt));

  return rows.filter((r) => !r.suppressedUntil || r.suppressedUntil <= today);
}

/** Silence a notification until a date, with a recorded reason. */
export async function suppressNotification(
  notificationKey: string,
  until: string,
  reason: string
) {
  await db
    .update(collegeNotifications)
    .set({ status: "suppressed", suppressedUntil: until, suppressionReason: reason })
    .where(eq(collegeNotifications.notificationKey, notificationKey));
}

/** Configure notification behaviour for an event type. */
export async function setNotificationPolicy(input: {
  eventType: string;
  severity: Severity;
  occurrencesBeforeSurfacing: number;
  notify: boolean;
  reason: string;
}) {
  const [existing] = await db
    .select()
    .from(collegeNotificationPolicy)
    .where(eq(collegeNotificationPolicy.eventType, input.eventType))
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(collegeNotificationPolicy)
      .set({
        severity: input.severity,
        occurrencesBeforeSurfacing: input.occurrencesBeforeSurfacing,
        notify: input.notify,
        reason: input.reason,
      })
      .where(eq(collegeNotificationPolicy.id, existing.id))
      .returning();
    return row;
  }

  const [row] = await db.insert(collegeNotificationPolicy).values(input).returning();
  return row;
}
