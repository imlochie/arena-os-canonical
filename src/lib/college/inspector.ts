// ============================================================================
// Lochie Life College — runtime inspector and session replay (SERVER ONLY)
// ============================================================================
// LAYER 6 §35 §36.
//
// Everything the runtime does is already recorded — attention decisions,
// ledger events, contributions, consultations, session members and their
// versions. What was missing is a way to ask a single question and get the
// whole picture back:
//
//   "What did the College know at this exact moment, and why did it act
//    the way it did?"
//
// REPLAY IS NOT RE-EXECUTION. Nothing here re-runs a class or rewrites a
// record. It reconstructs what was true at the time from immutable references
// the session already carries — the curriculum version it was pinned to, the
// member versions that served, the memory that existed, the events as they
// were ordered. A replay that could change history would defeat its purpose.
// ============================================================================

import { db } from "@/db";
import {
  collegeAttentionDecisions,
  collegeConsultations,
  collegeCourseSnapshots,
  collegeCourses,
  collegeCurriculumVersions,
  collegeEventLedger,
  collegeFacultyContributions,
  collegeFacultyMemberVersions,
  collegeFacultyMemory,
  collegeHandoffs,
  collegeSessionEventBus,
  collegeSessionEvents,
  collegeSessionFacultyMembers,
  collegeSessionPhases,
  collegeSessions,
} from "@/db/college";
import { asc, eq, inArray, lte } from "drizzle-orm";

export interface SessionInspection {
  session: typeof collegeSessions.$inferSelect;

  /** WHAT WAS SUPPOSED TO HAPPEN — the pinned institutional context. */
  pinned: {
    curriculumVersion: { id: string; label: string; versionNumber: number } | null;
    courseSnapshot: { id: string; code: string; title: string; capturedAt: string } | null;
    course: { id: string; code: string; title: string; currentStatus: string } | null;
    /** True when the live course has diverged from the snapshot. */
    courseHasChangedSince: boolean;
    divergence: string[];
  };

  /** WHO WAS RESPONSIBLE — at the versions that actually applied. */
  faculty: Array<{
    positionKey: string;
    memberId: string | null;
    memberName: string;
    participation: string;
    /** The configuration snapshot in force during this session. */
    versionAtTime: number | null;
    configurationAtTime: Record<string, unknown> | null;
    currentVersion: number | null;
    configurationHasChangedSince: boolean;
  }>;

  /** WHO PAID ATTENTION, AND WHY. */
  attention: Array<{
    eventType: string;
    positionKey: string;
    memberName: string;
    resolvedState: string;
    action: string;
    decidedBy: string;
    reason: string;
    at: string | null;
  }>;

  /** WHAT EACH MEMBER PRODUCED. */
  contributions: Array<{
    positionKey: string;
    contributionType: string;
    stance: string;
    truthClass: string;
    confidence: string;
    content: string;
    at: string | null;
  }>;

  /** HOW THEY COOPERATED. */
  coordination: {
    consultations: Array<{
      from: string;
      to: string;
      reason: string;
      question: string;
      response: string;
      status: string;
    }>;
    handoffs: Array<{ from: string; to: string; reason: string; disposition: string }>;
    phases: Array<{ phaseKey: string; primary: string[]; watching: string[]; note: string }>;
  };

  /** WHAT ACTUALLY HAPPENED — the ledger, in order. */
  ledger: Array<{
    time: string;
    sequence: number;
    eventType: string;
    summary: string;
    positionKey: string;
    detail: Record<string, unknown>;
  }>;

  /** THE RAW EVENT BUS — what the runtime was reacting to. */
  events: Array<{ sequence: number; eventType: string; emittedBy: string; payload: string }>;

  /** WHAT THE COLLEGE KNEW — memory that existed when this session ran. */
  memoryAtTime: Array<{
    positionKey: string;
    content: string;
    observationCount: number;
    promotionStatus: string;
    createdAt: string | null;
    /** False when this memory was created BY this session. */
    existedBefore: boolean;
  }>;

  /** Session lifecycle trail. */
  trail: Array<{ stage: string; note: string; actor: string; at: string | null }>;

  note: string;
}

/**
 * Reconstruct everything about one session.
 *
 * Divergence between the snapshot and the live record is reported, never
 * repaired — the point of a replay is to show that the College has changed
 * since, not to pretend it has not.
 */
export async function inspectSession(sessionId: string): Promise<SessionInspection | null> {
  const [session] = await db
    .select()
    .from(collegeSessions)
    .where(eq(collegeSessions.id, sessionId))
    .limit(1);
  if (!session) return null;

  // ---- PINNED CONTEXT ------------------------------------------------------
  let curriculumVersion: SessionInspection["pinned"]["curriculumVersion"] = null;
  if (session.curriculumVersionId) {
    const [v] = await db
      .select()
      .from(collegeCurriculumVersions)
      .where(eq(collegeCurriculumVersions.id, session.curriculumVersionId))
      .limit(1);
    if (v) {
      curriculumVersion = { id: v.id, label: v.label, versionNumber: v.versionNumber };
    }
  }

  let courseSnapshot: SessionInspection["pinned"]["courseSnapshot"] = null;
  let snapshotPayload: Record<string, unknown> | null = null;
  if (session.courseSnapshotId) {
    const [s] = await db
      .select()
      .from(collegeCourseSnapshots)
      .where(eq(collegeCourseSnapshots.id, session.courseSnapshotId))
      .limit(1);
    if (s) {
      // The snapshot stores the course fields directly rather than a blob.
      snapshotPayload = {
        code: s.code,
        title: s.title,
        summary: s.summary,
        status: s.status,
      };
      courseSnapshot = {
        id: s.id,
        code: s.code,
        title: s.title,
        capturedAt: s.capturedAt ? s.capturedAt.toISOString() : "",
      };
    }
  }

  let course: SessionInspection["pinned"]["course"] = null;
  const divergence: string[] = [];
  if (session.courseId) {
    const [c] = await db
      .select()
      .from(collegeCourses)
      .where(eq(collegeCourses.id, session.courseId))
      .limit(1);
    if (c) {
      course = { id: c.id, code: c.code, title: c.title, currentStatus: c.status };
      if (snapshotPayload) {
        if (snapshotPayload.title && snapshotPayload.title !== c.title) {
          divergence.push(
            `Course title was "${snapshotPayload.title}" at the time; it is now "${c.title}". The session keeps the historical identity.`
          );
        }
        if (snapshotPayload.code && snapshotPayload.code !== c.code) {
          divergence.push(
            `Course code was "${snapshotPayload.code}" at the time; it is now "${c.code}".`
          );
        }
        if (snapshotPayload.status && snapshotPayload.status !== c.status) {
          divergence.push(
            `Course status was "${snapshotPayload.status}" at the time; it is now "${c.status}".`
          );
        }
      }
    }
  }

  // ---- FACULTY AT THE VERSIONS THAT APPLIED --------------------------------
  const servedRows = await db
    .select()
    .from(collegeSessionFacultyMembers)
    .where(eq(collegeSessionFacultyMembers.sessionId, sessionId));

  const faculty: SessionInspection["faculty"] = [];
  for (const row of servedRows) {
    let configurationAtTime: Record<string, unknown> | null = null;
    let versionAtTime: number | null = null;
    let currentVersion: number | null = null;

    if (row.memberId) {
      // The version in force is the latest snapshot taken at or before the
      // session. Later edits must not be attributed to this class.
      const versions = await db
        .select()
        .from(collegeFacultyMemberVersions)
        .where(eq(collegeFacultyMemberVersions.memberId, row.memberId))
        .orderBy(asc(collegeFacultyMemberVersions.version));
      const cutoff = session.createdAt ?? new Date();
      const applicable = versions.filter((v) => (v.createdAt ?? new Date(0)) <= cutoff);
      const chosen = applicable.length ? applicable[applicable.length - 1] : null;
      if (chosen) {
        versionAtTime = chosen.version;
        configurationAtTime = safeJson(chosen.snapshot);
      }
      currentVersion = versions.length ? versions[versions.length - 1].version : null;
    }

    faculty.push({
      positionKey: row.positionKey,
      memberId: row.memberId,
      memberName: row.memberName,
      participation: row.participation,
      versionAtTime,
      configurationAtTime,
      currentVersion,
      configurationHasChangedSince:
        versionAtTime !== null && currentVersion !== null && currentVersion > versionAtTime,
    });
  }

  // ---- ATTENTION DECISIONS -------------------------------------------------
  const decisions = await db
    .select()
    .from(collegeAttentionDecisions)
    .where(eq(collegeAttentionDecisions.sessionId, sessionId))
    .orderBy(asc(collegeAttentionDecisions.createdAt));

  // ---- CONTRIBUTIONS -------------------------------------------------------
  const contribs = await db
    .select()
    .from(collegeFacultyContributions)
    .where(eq(collegeFacultyContributions.sessionId, sessionId))
    .orderBy(asc(collegeFacultyContributions.createdAt));

  // ---- COORDINATION --------------------------------------------------------
  const consults = await db
    .select()
    .from(collegeConsultations)
    .where(eq(collegeConsultations.sessionId, sessionId))
    .orderBy(asc(collegeConsultations.createdAt));
  const handoffs = await db
    .select()
    .from(collegeHandoffs)
    .where(eq(collegeHandoffs.sessionId, sessionId))
    .orderBy(asc(collegeHandoffs.createdAt));
  const phases = await db
    .select()
    .from(collegeSessionPhases)
    .where(eq(collegeSessionPhases.sessionId, sessionId))
    .orderBy(asc(collegeSessionPhases.sequence));

  // ---- LEDGER --------------------------------------------------------------
  const ledgerRows = await db
    .select()
    .from(collegeEventLedger)
    .where(eq(collegeEventLedger.sessionId, sessionId))
    .orderBy(asc(collegeEventLedger.sequence));

  // ---- EVENT BUS -----------------------------------------------------------
  const bus = await db
    .select()
    .from(collegeSessionEventBus)
    .where(eq(collegeSessionEventBus.sessionId, sessionId))
    .orderBy(asc(collegeSessionEventBus.sequence));

  // ---- MEMORY AS IT STOOD --------------------------------------------------
  const positionKeys = [...new Set(servedRows.map((r) => r.positionKey))];
  const memoryRows = positionKeys.length
    ? await db
        .select()
        .from(collegeFacultyMemory)
        .where(
          session.createdAt
            ? inArray(collegeFacultyMemory.positionKey, positionKeys)
            : inArray(collegeFacultyMemory.positionKey, positionKeys)
        )
    : [];
  const sessionStart = session.createdAt ?? new Date();
  const memoryAtTime = memoryRows
    .filter((m) => (m.createdAt ?? new Date(0)) <= sessionStart || m.sessionId === sessionId)
    .map((m) => ({
      positionKey: m.positionKey,
      content: m.content,
      observationCount: m.observationCount,
      promotionStatus: m.promotionStatus,
      createdAt: m.createdAt ? m.createdAt.toISOString() : null,
      existedBefore: m.sessionId !== sessionId,
    }));

  // ---- TRAIL ---------------------------------------------------------------
  const trail = await db
    .select()
    .from(collegeSessionEvents)
    .where(eq(collegeSessionEvents.sessionId, sessionId))
    .orderBy(asc(collegeSessionEvents.createdAt));

  return {
    session,
    pinned: {
      curriculumVersion,
      courseSnapshot,
      course,
      courseHasChangedSince: divergence.length > 0,
      divergence,
    },
    faculty,
    attention: decisions.map((d) => ({
      eventType: d.eventType,
      positionKey: d.positionKey,
      memberName: d.memberName ?? "",
      resolvedState: d.resolvedState,
      action: d.action,
      decidedBy: d.decidedBy,
      reason: d.reason,
      at: d.createdAt ? d.createdAt.toISOString() : null,
    })),
    contributions: contribs.map((c) => ({
      positionKey: c.positionKey,
      contributionType: c.contributionType,
      stance: c.stance,
      truthClass: c.truthClass,
      confidence: c.confidence,
      content: c.content,
      at: c.createdAt ? c.createdAt.toISOString() : null,
    })),
    coordination: {
      consultations: consults.map((c) => ({
        from: c.requestingPosition,
        to: c.requestedPosition,
        reason: c.reason,
        question: c.question,
        response: c.response ?? "",
        status: c.status,
      })),
      handoffs: handoffs.map((h) => ({
        from: h.fromPosition,
        to: h.toPosition,
        reason: h.reason,
        disposition: h.disposition,
      })),
      phases: phases.map((p) => ({
        phaseKey: p.phaseKey,
        primary: safeArray(p.primaryPositions),
        watching: safeArray(p.watchingPositions),
        note: p.note,
      })),
    },
    ledger: ledgerRows.map((l) => ({
      time: l.time,
      sequence: l.sequence,
      eventType: l.eventType,
      summary: l.summary,
      positionKey: l.positionKey,
      detail: safeJson(l.detail) ?? {},
    })),
    events: bus.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      emittedBy: e.emittedBy,
      payload: e.payload.slice(0, 600),
    })),
    memoryAtTime,
    trail: trail.map((t) => ({
      stage: t.stage,
      note: t.note,
      actor: t.actor,
      at: t.createdAt ? t.createdAt.toISOString() : null,
    })),
    note: "This is a reconstruction, not a re-execution. Nothing here re-ran the class or altered a record. Where the College has changed since, the divergence is reported rather than hidden.",
  };
}

/** Sessions available to inspect, newest first. */
export async function inspectableSessions(limit = 25) {
  const rows = await db
    .select({
      id: collegeSessions.id,
      title: collegeSessions.title,
      observedDate: collegeSessions.observedDate,
      status: collegeSessions.status,
      stage: collegeSessions.stage,
      sessionKind: collegeSessions.sessionKind,
      courseId: collegeSessions.courseId,
      summary: collegeSessions.summary,
      createdAt: collegeSessions.createdAt,
    })
    .from(collegeSessions)
    .orderBy(asc(collegeSessions.createdAt));
  return rows.reverse().slice(0, limit);
}

/**
 * What did the College know at a given moment, independent of a session?
 * Used by the inspector's "as at" view.
 */
export async function knowledgeAsAt(atIso: string) {
  const at = new Date(atIso);
  const memory = await db
    .select()
    .from(collegeFacultyMemory)
    .where(lte(collegeFacultyMemory.createdAt, at));
  const ledgerRows = await db
    .select()
    .from(collegeEventLedger)
    .where(lte(collegeEventLedger.createdAt, at))
    .orderBy(asc(collegeEventLedger.createdAt));
  return {
    at: atIso,
    facultyMemoryCount: memory.length,
    ledgerEventCount: ledgerRows.length,
    memory: memory.slice(-20).map((m) => ({
      positionKey: m.positionKey,
      content: m.content.slice(0, 200),
      observationCount: m.observationCount,
      promotionStatus: m.promotionStatus,
    })),
    note: "Reconstructed from creation timestamps. Records are append-oriented, so this is what existed — not what was later believed.",
  };
}

function safeJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
