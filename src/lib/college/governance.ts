// ============================================================================
// Lochie Life College — the governance queue (SERVER ONLY)
// ============================================================================
// LAYER 6 §31, and the enforcement point for §29.
//
// The College can now notice a great many things. This module is what stops
// noticing from becoming acting. Everything that requires an institutional
// decision lands in ONE queue, phrased the same way:
//
//   WHAT · WHY · EVIDENCE · SOURCE · IMPACT · AUTHORITY REQUIRED
//
// The queue is DERIVED, not stored. Every item already exists somewhere —
// a proposal, a reconciliation, an audit signal, a memory awaiting promotion,
// a timetable conflict. Creating a second copy would let the copy drift from
// the truth. Reading them through one lens costs a few queries and keeps a
// single source for each fact.
//
// Nothing in this file changes anything. That is the point: an audit may
// produce a REVIEW SIGNAL, but governance decides whether anything changes,
// and governance is the founder.
// ============================================================================

import { db } from "@/db";
import {
  collegeAudits,
  collegeCurriculumProposals,
  collegeFacultyMemory,
  collegeReconciliations,
} from "@/db/college";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getCurrentCurriculum } from "./curriculum";
import { detectTimetableConflicts } from "./timetable";
import { FACULTY_MEMORY_CROSSING_THRESHOLD } from "./faculty-memory";
import { brisbaneToday } from "./time";

export type GovernanceKind =
  | "curriculum_change_proposed"
  | "timetable_change_proposed"
  | "faculty_change_proposed"
  | "source_conflict_requires_decision"
  | "memory_promotion_requires_review"
  | "audit_review_signal";

export type AuthorityRequired =
  | "founder"
  | "institutional_authority"
  | "administration"
  | "none";

export interface GovernanceItem {
  id: string;
  kind: GovernanceKind;
  /** WHAT is being asked. */
  what: string;
  /** WHY it is being asked now. */
  why: string;
  /** EVIDENCE the request rests on. Never a recommendation on its own. */
  evidence: string[];
  /** SOURCE — where this came from. */
  source: string;
  /** IMPACT if it is accepted. */
  impact: string;
  /** AUTHORITY REQUIRED to decide it. */
  authorityRequired: AuthorityRequired;
  /** Where the founder goes to act on it. */
  actionPath: string;
  raisedOn: string | null;
  /**
   * Whether this item is merely informational. A review signal is NOT a
   * request to change anything — it is a request to LOOK.
   */
  informationalOnly: boolean;
}

export interface GovernanceQueue {
  items: GovernanceItem[];
  byKind: Record<string, number>;
  note: string;
}

/**
 * Build the queue.
 *
 * Deliberately conservative about what qualifies. An institution that asks its
 * founder to decide forty things a week has not built governance, it has built
 * nagging — and the standing instruction is to leave functioning systems alone.
 */
export async function governanceQueue(): Promise<GovernanceQueue> {
  const items: GovernanceItem[] = [];

  // ---- 1. CURRICULUM PROPOSALS — AI PROPOSAL ≠ INSTITUTIONAL DECISION -----
  const proposals = await db
    .select()
    .from(collegeCurriculumProposals)
    .where(eq(collegeCurriculumProposals.status, "proposed"))
    .orderBy(desc(collegeCurriculumProposals.createdAt))
    .limit(20);
  for (const p of proposals) {
    items.push({
      id: `proposal:${p.id}`,
      kind: "curriculum_change_proposed",
      what: p.title || "Curriculum proposal",
      why: p.rationale || "(no rationale recorded)",
      evidence: splitLines(p.evidence),
      source: `Proposed by ${p.proposedBy || "unknown"}.`,
      impact:
        p.expectedConsequences ||
        "Consequences were not stated. Treat the proposal as incomplete.",
      authorityRequired: "founder",
      actionPath: "/college/curriculum",
      raisedOn: p.createdAt ? p.createdAt.toISOString().slice(0, 10) : null,
      informationalOnly: false,
    });
  }

  // ---- 2. SOURCE CONFLICTS — an institutional decision is needed ----------
  const conflicts = await db
    .select()
    .from(collegeReconciliations)
    .where(eq(collegeReconciliations.status, "unresolved"))
    .orderBy(desc(collegeReconciliations.createdAt))
    .limit(20);
  for (const c of conflicts) {
    items.push({
      id: `conflict:${c.id}`,
      kind: "source_conflict_requires_decision",
      what: c.subject || "Two sources disagree.",
      why: "Two authoritative sources disagree and the College cannot proceed on both readings.",
      evidence: [
        `${c.sourceAKey}: ${c.sourceAClaim}`,
        `${c.sourceBKey}: ${c.sourceBClaim}`,
      ].filter(Boolean),
      source: `${c.sourceAKey} vs ${c.sourceBKey}`,
      impact:
        "Deciding makes one reading operationally authoritative. Both original claims are preserved exactly as recorded — deciding does not erase the disagreement.",
      authorityRequired: "founder",
      actionPath: "/college#conflicts",
      raisedOn: c.createdAt ? c.createdAt.toISOString().slice(0, 10) : null,
      informationalOnly: false,
    });
  }

  // ---- 3. MEMORY AWAITING PROMOTION REVIEW --------------------------------
  // Only memory that has actually crossed the corroboration threshold. A
  // single observation is not a governance matter; it is just a memory.
  const promotable = await db
    .select()
    .from(collegeFacultyMemory)
    .where(
      and(
        eq(collegeFacultyMemory.active, true),
        eq(collegeFacultyMemory.promotionStatus, "proposed"),
        gte(collegeFacultyMemory.observationCount, FACULTY_MEMORY_CROSSING_THRESHOLD)
      )
    )
    .orderBy(desc(collegeFacultyMemory.observationCount))
    .limit(15);
  for (const m of promotable) {
    items.push({
      id: `memory:${m.id}`,
      kind: "memory_promotion_requires_review",
      what: `Promote a faculty observation into institutional memory: "${m.content.slice(0, 160)}"`,
      why: `Observed ${m.observationCount} times independently, which meets the crossing threshold of ${FACULTY_MEMORY_CROSSING_THRESHOLD}.`,
      evidence: [
        `Recorded by the ${m.positionKey} position.`,
        `Independent observations: ${m.observationCount}.`,
        `Claimed scope: ${m.memoryScope}.`,
      ],
      source: "Faculty memory",
      impact:
        "If promoted it enters institutional memory at the OBSERVATION rung — the lowest — and still has to earn its way up. It does not become established truth.",
      authorityRequired: "founder",
      actionPath: "/college/inspector",
      raisedOn: m.createdAt ? m.createdAt.toISOString().slice(0, 10) : null,
      informationalOnly: false,
    });
  }

  // ---- 4. TIMETABLE ↔ CURRICULUM MISMATCHES -------------------------------
  try {
    const current = await getCurrentCurriculum();
    const activeIds = current.courses
      .filter((c) => String((c as { status?: string }).status ?? "active") === "active")
      .map((c) => String((c as { id: string }).id));
    const tc = await detectTimetableConflicts(activeIds);
    for (const conflict of tc) {
      if (conflict.severity === "low") continue;
      items.push({
        id: `timetable:${conflict.slotId ?? conflict.courseId ?? conflict.kind}`,
        kind: "timetable_change_proposed",
        what: conflict.detail,
        why: "The timetable and the curriculum disagree about what is being taught.",
        evidence: [conflict.detail],
        source: "Timetable ↔ curriculum reconciliation",
        impact:
          "Resolving this changes either the timetable or the curriculum. The mismatch is surfaced rather than repaired, because either fix is an institutional decision.",
        authorityRequired: "founder",
        actionPath: "/college/timetable",
        raisedOn: brisbaneToday(),
        informationalOnly: false,
      });
    }
  } catch {
    // A failure to detect conflicts must not empty the queue silently.
    items.push({
      id: "timetable:detection_failed",
      kind: "timetable_change_proposed",
      what: "Timetable/curriculum conflict detection failed.",
      why: "The check could not run, so mismatches may exist and be invisible.",
      evidence: [],
      source: "System",
      impact: "None until the check runs. Treat the timetable as unverified.",
      authorityRequired: "none",
      actionPath: "/college/timetable",
      raisedOn: brisbaneToday(),
      informationalOnly: true,
    });
  }

  // ---- 5. AUDIT REVIEW SIGNALS — §29, observation only --------------------
  // An audit may say "look at this". It may never change anything itself, and
  // it must not be phrased as a request to change something.
  const audits = await db
    .select()
    .from(collegeAudits)
    .where(sql`${collegeAudits.decision} in ('investigate','propose_change')`)
    .orderBy(desc(collegeAudits.createdAt))
    .limit(10);
  for (const a of audits) {
    items.push({
      id: `audit:${a.id}`,
      kind: "audit_review_signal",
      what: `Review signal from the ${a.scopeType} audit: ${a.scopeLabel}`,
      why: a.interpretation?.slice(0, 500) || "An audit recorded a signal worth looking at.",
      evidence: splitLines(a.evidenceConsidered),
      source: `Audit recorded ${a.createdAt ? a.createdAt.toISOString().slice(0, 10) : "(undated)"}`,
      impact:
        "None automatically. An audit observes; it does not optimise. Nothing changes unless the founder decides it should.",
      authorityRequired: "founder",
      actionPath: "/college/audit",
      raisedOn: a.createdAt ? a.createdAt.toISOString().slice(0, 10) : null,
      informationalOnly: true,
    });
  }

  const byKind: Record<string, number> = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;

  return {
    items,
    byKind,
    note: items.length
      ? "Every item here requires an institutional decision. Nothing in this queue has changed anything, and nothing will until you decide it should. Review signals are requests to look, not requests to act."
      : "Nothing requires an institutional decision. NO CHANGE INDICATED — leave the functioning system alone.",
  };
}

function splitLines(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) return v.map(String).slice(0, 8);
  } catch {
    // not JSON — fall through
  }
  return trimmed
    .split(/\n+/)
    .map((l) => l.replace(/^[-·*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}
