// ============================================================================
// Lochie Life College — LAYER 7, part 2: THE EXTERNAL ACADEMIC WORLD
// ============================================================================
// The College does not replace TAFE. It needs to know:
//
//   "This is what TAFE requires, this is where you are in it, this is what has
//    happened since you last studied, and this is how today's College session
//    fits around that reality."
//
// Four rules hold this module in place:
//
//   1. THE PROVIDER IS THE AUTHORITY. Arena records what it was told and by
//      whom. It never computes external progress, never marks an external unit
//      complete, and never contradicts the provider.
//
//   2. REPORTED IS NOT VERIFIED. Every commitment carries an evidence level.
//      "Lochie said the assessment is due Friday" and "the assessment schedule
//      says Friday" are different facts and stay different.
//
//   3. EXTERNAL PRESSURE IS CONTEXT, NOT COMMAND. A TAFE deadline may change
//      what today's College session should attempt. It must never silently
//      rewrite the timetable or the curriculum — the Layer 4 rule that
//      "student unavailable" never becomes a permanent timetable change
//      applies here exactly as written.
//
//   4. SILENCE IS NOT ABSENCE. If nothing is recorded, the College says it
//      knows nothing about TAFE. It does not infer that nothing is happening.
// ============================================================================

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { collegeExternalCommitments } from "@/db/college";
import { brisbaneToday } from "./time";
import { daysBetween } from "./temporal-state";

export interface ExternalCommitment {
  id: string;
  provider: string;
  title: string;
  commitmentType: string;
  progressState: string;
  status: string;
  startsOn: string | null;
  dueOn: string | null;
  endsOn: string | null;
  evidenceLevel: string;
  sourceNote: string;
  /** Days until `dueOn`. Negative = past. Null when there is no dated target. */
  daysUntilDue: number | null;
  /** Diagnostic sentence. Never a score, never an instruction. */
  condition: string;
  /** True only when a REAL dated deadline is close. */
  imminent: boolean;
}

export interface ExternalAcademicPicture {
  /** Whether the College has been told anything at all. */
  known: boolean;
  commitments: ExternalCommitment[];
  /** Commitments with a dated deadline inside the pressure window. */
  imminent: ExternalCommitment[];
  /**
   * What this means for today's College session — always phrased as context
   * the founder may act on, never as an instruction the runtime will execute.
   */
  implication: string;
  note: string;
}

/** Deadlines inside this many days count as temporal pressure worth surfacing. */
export const EXTERNAL_PRESSURE_WINDOW_DAYS = 10;

function conditionFor(
  daysUntilDue: number | null,
  status: string,
  evidenceLevel: string,
  progressState: string
): string {
  const caveat =
    evidenceLevel === "reported"
      ? " Reported to the College, not verified against the provider."
      : "";

  if (status === "completed") return `Recorded as completed by the provider.${caveat}`;
  if (status === "withdrawn") return `Recorded as withdrawn.${caveat}`;
  if (daysUntilDue === null) {
    return progressState
      ? `In progress: ${progressState}. No dated deadline recorded.${caveat}`
      : `Active with no dated deadline recorded.${caveat}`;
  }
  if (daysUntilDue < 0) {
    return `Due date passed ${Math.abs(daysUntilDue)} day(s) ago. The College does not know the outcome — only the provider does.${caveat}`;
  }
  if (daysUntilDue === 0) return `Due today.${caveat}`;
  if (daysUntilDue <= EXTERNAL_PRESSURE_WINDOW_DAYS) {
    return `Due in ${daysUntilDue} day(s). This is real external pressure on the student's available attention.${caveat}`;
  }
  return `Due in ${daysUntilDue} day(s). Not yet pressing.${caveat}`;
}

export async function externalAcademicPicture(
  now: Date = new Date()
): Promise<ExternalAcademicPicture> {
  const today = brisbaneToday(now);
  const rows = await db
    .select()
    .from(collegeExternalCommitments)
    .where(eq(collegeExternalCommitments.active, true))
    .orderBy(desc(collegeExternalCommitments.createdAt));

  const commitments: ExternalCommitment[] = rows.map((r) => {
    const daysUntilDue =
      r.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(r.dueOn)
        ? daysBetween(today, r.dueOn)
        : null;
    const imminent =
      daysUntilDue !== null &&
      daysUntilDue >= 0 &&
      daysUntilDue <= EXTERNAL_PRESSURE_WINDOW_DAYS &&
      r.status !== "completed" &&
      r.status !== "withdrawn";

    return {
      id: r.id,
      provider: r.provider,
      title: r.title,
      commitmentType: r.commitmentType,
      progressState: r.progressState,
      status: r.status,
      startsOn: r.startsOn,
      dueOn: r.dueOn,
      endsOn: r.endsOn,
      evidenceLevel: r.evidenceLevel,
      sourceNote: r.sourceNote,
      daysUntilDue,
      condition: conditionFor(daysUntilDue, r.status, r.evidenceLevel, r.progressState),
      imminent,
    };
  });

  const imminent = commitments.filter((c) => c.imminent);

  let implication: string;
  if (!commitments.length) {
    implication =
      "The College has no record of any external academic commitment. That is an absence of information, not evidence that none exists.";
  } else if (!imminent.length) {
    implication =
      "No external deadline falls inside the pressure window. Today's College session can proceed on its own terms.";
  } else {
    const names = imminent
      .map((c) => `${c.provider} — ${c.title} (${c.dueOn})`)
      .join("; ");
    implication =
      `External work is due soon: ${names}. This is context for deciding what today's session should attempt. ` +
      "It does not change the timetable or the curriculum, and the College will not reschedule anything on its own.";
  }

  return {
    known: commitments.length > 0,
    commitments,
    imminent,
    implication,
    note:
      "The provider is the authority on external academic work. Arena records what it was told, with its evidence level, and never asserts an external result.",
  };
}
