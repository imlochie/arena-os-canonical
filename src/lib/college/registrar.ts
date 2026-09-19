// ============================================================================
// Lochie Life College — Registrar (SERVER ONLY)
// ============================================================================
// The Registrar is an institutional FUNCTION, not a personality. Its job is to
// decide what is record-worthy, propose records with provenance, and protect
// chronology.
//
// Hard rules enforced here:
//   • Not every conversation becomes history. Record-worthiness is tested.
//   • Proposing ≠ filing. Filing is a separate, explicit institutional act.
//   • History is append-only. A correction SUPERSEDES; it never overwrites.
//   • Chronology (occurredOn) is tracked separately from when it was recorded
//     and when it was filed, so later understanding cannot rewrite the past.
// ============================================================================

import { db } from "@/db";
import { collegeRecords, collegeSessions } from "@/db/college";
import { desc, eq } from "drizzle-orm";

/** Record types the Registrar recognises as potentially historical. */
export const RECORD_TYPES = [
  "milestone",
  "decision",
  "curriculum_change",
  "goal_change",
  "learning_discovery",
  "progression",
  "correction",
  "teaching_strategy_change",
  "institutional_change",
  "session_record",
  "administrative",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export interface WorthinessResult {
  recordWorthy: boolean;
  reason: string;
  suggestedType: RecordType | null;
}

/**
 * Decide whether something belongs in the institutional record.
 *
 * This is deliberately conservative and rule-based rather than a model call:
 * "Do not dump every conversation into the historical record." A routine
 * session that produced no milestone, decision, discovery or correction is
 * working material, and working material is not history.
 */
export function assessRecordWorthiness(input: {
  recordType?: string;
  subject: string;
  content: string;
  producedMilestone?: boolean;
  producedDecision?: boolean;
  producedDiscovery?: boolean;
  changedCurriculum?: boolean;
  changedGoal?: boolean;
  changedTeachingStrategy?: boolean;
  isCorrection?: boolean;
  sessionCompleted?: boolean;
}): WorthinessResult {
  const subject = input.subject?.trim() ?? "";
  if (subject.length < 3) {
    return {
      recordWorthy: false,
      reason: "No substantive subject supplied.",
      suggestedType: null,
    };
  }

  if (input.isCorrection) {
    return {
      recordWorthy: true,
      reason: "Corrections to prior records are always recorded, by supersession.",
      suggestedType: "correction",
    };
  }
  if (input.changedCurriculum) {
    return {
      recordWorthy: true,
      reason: "A change to curriculum alters what the institution teaches.",
      suggestedType: "curriculum_change",
    };
  }
  if (input.producedDecision) {
    return {
      recordWorthy: true,
      reason: "An institutional decision was made and must be traceable.",
      suggestedType: "decision",
    };
  }
  if (input.producedMilestone) {
    return {
      recordWorthy: true,
      reason: "A course or progression milestone was reached.",
      suggestedType: "milestone",
    };
  }
  if (input.changedTeachingStrategy) {
    return {
      recordWorthy: true,
      reason: "A change in teaching strategy must be explainable later.",
      suggestedType: "teaching_strategy_change",
    };
  }
  if (input.changedGoal) {
    return {
      recordWorthy: true,
      reason: "A goal was created, completed or materially changed.",
      suggestedType: "goal_change",
    };
  }
  if (input.producedDiscovery) {
    return {
      recordWorthy: true,
      reason: "A significant learning discovery was made.",
      suggestedType: "learning_discovery",
    };
  }

  if (input.sessionCompleted) {
    return {
      recordWorthy: true,
      reason:
        "A completed teaching session is part of academic history, recorded as a session record.",
      suggestedType: "session_record",
    };
  }

  return {
    recordWorthy: false,
    reason:
      "Routine working material: no milestone, decision, discovery, correction or completed session. This stays working material and does not enter the historical record.",
    suggestedType: null,
  };
}

export interface ProposeRecordInput {
  recordType: RecordType | string;
  subject: string;
  content: string;
  occurredOn?: string | null;
  termId?: string | null;
  weekIndex?: number | null;
  courseId?: string | null;
  sourceSessionId?: string | null;
  authoringFaculty?: string;
  provenance: string;
  truthClass?: string;
  confidence?: string;
  supersedesId?: string | null;
  correctionReason?: string;
}

/**
 * Propose a record. Status is always "proposed" — the Registrar never files.
 */
export async function proposeRecord(input: ProposeRecordInput) {
  const [row] = await db
    .insert(collegeRecords)
    .values({
      recordType: String(input.recordType).slice(0, 40),
      subject: input.subject.slice(0, 300),
      content: input.content.slice(0, 20000),
      occurredOn: input.occurredOn ?? null,
      termId: input.termId ?? null,
      weekIndex: input.weekIndex ?? null,
      courseId: input.courseId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      authoringFaculty: input.authoringFaculty ?? "registrar",
      provenance: input.provenance.slice(0, 500),
      truthClass: input.truthClass ?? "fact",
      confidence: input.confidence ?? "known",
      status: "proposed",
      supersedesId: input.supersedesId ?? null,
      correctionReason: (input.correctionReason ?? "").slice(0, 500),
    })
    .returning();
  return row;
}

/**
 * File a proposed record. This is the institutional act that turns a proposal
 * into history. Supersession is applied here, append-only: the superseded row
 * keeps its content and is marked, never edited away.
 */
export async function fileRecord(id: string) {
  const [existing] = await db.select().from(collegeRecords).where(eq(collegeRecords.id, id)).limit(1);
  if (!existing) return { ok: false as const, error: "record not found" };
  if (existing.status === "filed") return { ok: false as const, error: "record already filed" };

  const [filed] = await db
    .update(collegeRecords)
    .set({ status: "filed", filedAt: new Date() })
    .where(eq(collegeRecords.id, id))
    .returning();

  if (existing.supersedesId) {
    await db
      .update(collegeRecords)
      .set({ status: "superseded", supersededById: id })
      .where(eq(collegeRecords.id, existing.supersedesId));
  }

  if (existing.sourceSessionId) {
    await db
      .update(collegeSessions)
      .set({ filedAt: new Date(), filedRecordId: id })
      .where(eq(collegeSessions.id, existing.sourceSessionId));
  }

  return { ok: true as const, record: filed };
}

/**
 * Chronological history. Ordered by when events OCCURRED, not when they were
 * written down — preserving chronology before interpretation.
 */
export async function getHistory(limit = 50) {
  const rows = await db
    .select()
    .from(collegeRecords)
    .orderBy(desc(collegeRecords.occurredOn), desc(collegeRecords.recordedAt))
    .limit(limit);
  return rows;
}
