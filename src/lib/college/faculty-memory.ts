import "server-only";

import { db } from "@/db";
import { collegeFacultyMemory, collegeMemory, collegeSessions } from "@/db/college";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { canPromote, type EpistemicStatus } from "./truth";
import * as ledger from "./ledger";

/**
 * FACULTY MEMORY
 *
 * Four kinds of knowledge must not be confused:
 *
 *   SOURCE MATERIAL     the handbook and Notion canon. Arena never mutates it.
 *   INSTITUTIONAL MEMORY what the College holds to be true. Gated, corroborated.
 *   SESSION RECORD      what happened in one class. Factual, append-only.
 *   FACULTY MEMORY      what a teacher noticed and found useful. ← this module
 *
 * Faculty memory is the loosest of the four by design: remember generously,
 * believe cautiously. A teacher noticing "the concrete example landed better"
 * is worth keeping, but it is one person's read of one moment. It must never
 * leak upward into institutional truth without passing the same corroboration
 * gates every other memory passes.
 *
 * So: writing here is cheap. Promotion out of here is not.
 */

/**
 * How many independent observations a faculty memory needs before it may be
 * proposed for institutional memory at all.
 *
 * Two, not one. A single noticing is a hunch; it belongs to the teacher who
 * had it. The College does not adopt hunches.
 */
export const FACULTY_MEMORY_CROSSING_THRESHOLD = 2;

export const FACULTY_MEMORY_KINDS = [
  "teaching_observation", // "the concrete example seemed to land"
  "useful_explanation", // a phrasing worth reusing
  "response_pattern", // "tends to agree before understanding"
  "course_lesson", // something learned about teaching THIS course
  "unresolved_question", // left open at the end of a session
  "successful_intervention", // something that visibly helped
] as const;

export type FacultyMemoryKind = (typeof FACULTY_MEMORY_KINDS)[number];

export interface FacultyMemoryEntry {
  id: string;
  memberId: string | null;
  positionKey: string;
  courseId: string | null;
  sessionId: string | null;
  content: string;
  memoryScope: string;
  observationCount: number;
  promotionStatus: string;
  createdAt: Date | null;
}

/**
 * Record something a faculty member noticed.
 *
 * Bounded deliberately: a member may only write memory if its configuration
 * permits it, and only within its configured scope. An Observer configured to
 * `memoryScopeLimit: "session"` cannot quietly start forming beliefs about the
 * student in general.
 */
export async function remember(input: {
  memberId: string | null;
  positionKey: string;
  courseId?: string | null;
  sessionId?: string | null;
  content: string;
  kind: FacultyMemoryKind;
  /** From the member's effective policy. */
  memoryEnabled?: boolean;
  memoryScopeLimit?: string;
}): Promise<{ ok: boolean; entry?: FacultyMemoryEntry; refused?: string }> {
  if (input.memoryEnabled === false) {
    return {
      ok: false,
      refused: "This faculty member is configured not to retain memory.",
    };
  }

  const content = input.content.trim();
  if (!content) return { ok: false, refused: "Empty observation." };

  // The scope of a claim may not exceed the member's configured limit.
  const requested = scopeForKind(input.kind);
  const limit = input.memoryScopeLimit ?? "course";
  const scopeOrder = ["session", "course", "student", "subject"];
  if (scopeOrder.indexOf(requested) > scopeOrder.indexOf(limit)) {
    return {
      ok: false,
      refused: `This member may only retain memory at "${limit}" scope; the observation claims "${requested}" scope.`,
    };
  }

  // Near-identical observations increment a count rather than pile up. That
  // count is what eventually makes something worth believing.
  const existing = await db
    .select()
    .from(collegeFacultyMemory)
    .where(
      and(
        eq(collegeFacultyMemory.active, true),
        eq(collegeFacultyMemory.positionKey, input.positionKey),
        input.courseId
          ? eq(collegeFacultyMemory.courseId, input.courseId)
          : isNull(collegeFacultyMemory.courseId),
        sql`lower(${collegeFacultyMemory.content}) = lower(${content})`
      )
    )
    .limit(1);

  if (existing.length) {
    const [row] = await db
      .update(collegeFacultyMemory)
      .set({ observationCount: existing[0].observationCount + 1 })
      .where(eq(collegeFacultyMemory.id, existing[0].id))
      .returning();
    return { ok: true, entry: toEntry(row) };
  }

  const [row] = await db
    .insert(collegeFacultyMemory)
    .values({
      memberId: input.memberId,
      positionKey: input.positionKey,
      courseId: input.courseId ?? null,
      sessionId: input.sessionId ?? null,
      content: content.slice(0, 4000),
      memoryScope: requested,
      observationCount: 1,
      promotionStatus: "private",
    })
    .returning();

  await ledger.record({
    eventType: "memory_recorded",
    summary: `${input.positionKey} recorded a ${input.kind.replace(/_/g, " ")}.`,
    detail: { kind: input.kind, scope: requested },
    sessionId: input.sessionId ?? null,
    courseId: input.courseId ?? null,
    memberId: input.memberId,
    positionKey: input.positionKey,
    actor: `faculty:${input.positionKey}`,
  });

  return { ok: true, entry: toEntry(row) };
}

function scopeForKind(kind: FacultyMemoryKind): string {
  switch (kind) {
    case "unresolved_question":
      return "session";
    case "useful_explanation":
    case "course_lesson":
    case "successful_intervention":
    case "teaching_observation":
      return "course";
    case "response_pattern":
      return "student";
    default:
      return "session";
  }
}

/**
 * Retrieve memory relevant to a teaching moment.
 *
 * Returned entries are LABELLED, never presented as objective fact. The caller
 * is expected to render them with their provenance intact — a remembered
 * interpretation is not evidence.
 */
export async function recall(input: {
  positionKey: string;
  memberId?: string | null;
  courseId?: string | null;
  limit?: number;
  memoryEnabled?: boolean;
}): Promise<
  Array<{
    content: string;
    label: string;
    source: string;
    confidence: string;
    observationCount: number;
  }>
> {
  if (input.memoryEnabled === false) return [];

  const rows = await db
    .select()
    .from(collegeFacultyMemory)
    .where(
      and(
        eq(collegeFacultyMemory.active, true),
        eq(collegeFacultyMemory.positionKey, input.positionKey),
        input.courseId
          ? or(
              eq(collegeFacultyMemory.courseId, input.courseId),
              isNull(collegeFacultyMemory.courseId)
            )
          : isNull(collegeFacultyMemory.courseId)
      )
    )
    .orderBy(desc(collegeFacultyMemory.observationCount), desc(collegeFacultyMemory.createdAt))
    .limit(input.limit ?? 5);

  // Resolve session titles so a memory can cite where it came from.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean))] as string[];
  const sessions = sessionIds.length
    ? await db.select().from(collegeSessions).where(
        or(...sessionIds.map((id) => eq(collegeSessions.id, id)))
      )
    : [];
  const titleById = new Map(sessions.map((s) => [s.id, s.title]));

  return rows.map((r) => ({
    content: r.content,
    label: "FACULTY MEMORY",
    source: r.sessionId ? (titleById.get(r.sessionId) ?? "an earlier session") : "accumulated observation",
    // Confidence is a function of corroboration, never of how strongly the
    // model feels about it.
    confidence:
      r.observationCount >= 3 ? "repeatedly observed" : r.observationCount === 2 ? "seen twice" : "seen once",
    observationCount: r.observationCount,
  }));
}

/**
 * Render recalled memory for a context packet.
 *
 * The labelling here matters: the model must not be able to mistake a
 * remembered interpretation for an institutional fact.
 */
export function renderForContext(
  entries: Array<{ content: string; source: string; confidence: string }>
): string {
  if (!entries.length) return "";
  const lines = entries.map(
    (e) => `- [FACULTY MEMORY | source: ${e.source} | confidence: ${e.confidence}] ${e.content}`
  );
  return [
    "RELEVANT FACULTY MEMORY",
    "These are your own prior observations, not institutional fact. They may be",
    "wrong, out of date, or specific to one moment. Use them as a hint about what",
    "to try, never as evidence about what is true.",
    ...lines,
  ].join("\n");
}

/**
 * Offer a faculty memory for promotion into institutional memory.
 *
 * This does NOT promote it. It routes the claim through the same corroboration
 * gate every other memory passes, and records the outcome. Faculty memory
 * becoming institutional truth is an institutional act, not a side effect of
 * a teacher being confident.
 */
export async function proposePromotion(
  facultyMemoryId: string,
  reason: string
): Promise<{ ok: boolean; status: string; message: string }> {
  const [row] = await db
    .select()
    .from(collegeFacultyMemory)
    .where(eq(collegeFacultyMemory.id, facultyMemoryId))
    .limit(1);

  if (!row) return { ok: false, status: "not_found", message: "No such faculty memory." };

  // TWO SEPARATE GATES.
  //
  // `canPromote` governs movement UP the institutional ladder
  // (observation → interpretation → hypothesis → established). It is not the
  // right question here. Crossing the boundary FROM faculty memory INTO
  // institutional memory at all is a different and stricter question: one
  // teacher noticing one thing once is precisely what must not become
  // institutional truth.
  //
  // So the crossing requires independent corroboration first. Only then does
  // the entry take its place at the bottom of the institutional ladder and
  // start climbing under the usual rules.
  if (row.observationCount < FACULTY_MEMORY_CROSSING_THRESHOLD) {
    await db
      .update(collegeFacultyMemory)
      .set({ promotionStatus: "proposed" })
      .where(eq(collegeFacultyMemory.id, facultyMemoryId));
    return {
      ok: false,
      status: "insufficient_corroboration",
      message: `Not promoted. Faculty memory needs ${FACULTY_MEMORY_CROSSING_THRESHOLD} independent observations before it may enter institutional memory; this has ${row.observationCount}. The observation is preserved as faculty memory and remains available to teaching — it simply is not institutional truth.`,
    };
  }

  // Past the crossing, the normal institutional ladder applies.
  const gate = canPromote("observation" as EpistemicStatus, row.observationCount);
  if (!gate.allowed) {
    await db
      .update(collegeFacultyMemory)
      .set({ promotionStatus: "proposed" })
      .where(eq(collegeFacultyMemory.id, facultyMemoryId));
    return {
      ok: false,
      status: "insufficient_corroboration",
      message: `Not promoted. ${gate.reason} The observation is preserved as faculty memory and remains available; it simply is not institutional truth yet.`,
    };
  }

  const [promoted] = await db
    .insert(collegeMemory)
    .values({
      scope: "teaching",
      courseId: row.courseId,
      sessionId: row.sessionId,
      epistemicStatus: "observation",
      memoryType: "observation",
      content: row.content,
      corroborationCount: row.observationCount,
      authoredBy: `faculty:${row.positionKey}`,
      truthClass: "interpretation",
      confidence: "inferred",
    })
    .returning();

  await db
    .update(collegeFacultyMemory)
    .set({ promotionStatus: "promoted", promotedMemoryId: promoted.id })
    .where(eq(collegeFacultyMemory.id, facultyMemoryId));

  await ledger.record({
    eventType: "memory_promoted",
    summary: `A faculty observation was promoted into institutional memory.`,
    detail: { reason, corroboration: row.observationCount },
    courseId: row.courseId,
    memberId: row.memberId,
    positionKey: row.positionKey,
    actor: "founder",
    severity: "low",
  });

  return {
    ok: true,
    status: "promoted",
    message:
      "Promoted into institutional memory as an OBSERVATION — the lowest rung. It still has to earn its way up like anything else.",
  };
}

/** All memory held by one position, for inspection. */
export async function listFor(positionKey: string, courseId?: string | null) {
  return db
    .select()
    .from(collegeFacultyMemory)
    .where(
      and(
        eq(collegeFacultyMemory.positionKey, positionKey),
        eq(collegeFacultyMemory.active, true),
        courseId ? eq(collegeFacultyMemory.courseId, courseId) : sql`true`
      )
    )
    .orderBy(desc(collegeFacultyMemory.createdAt));
}

function toEntry(r: typeof collegeFacultyMemory.$inferSelect): FacultyMemoryEntry {
  return {
    id: r.id,
    memberId: r.memberId,
    positionKey: r.positionKey,
    courseId: r.courseId,
    sessionId: r.sessionId,
    content: r.content,
    memoryScope: r.memoryScope,
    observationCount: r.observationCount,
    promotionStatus: r.promotionStatus,
    createdAt: r.createdAt,
  };
}
