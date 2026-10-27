// ============================================================================
// Lochie Life College — per-member bounded context (SERVER ONLY)
// ============================================================================
// LAYER 6 §3 §4 §5 §17 §18.
//
// `context.ts` builds a packet per POSITION. That was the right first move,
// but it is not yet what the brief asks for: every faculty MEMBER should
// receive a packet shaped by its own configuration, its own attention state,
// and its own memory — and nothing else.
//
// This module wraps the position packet rather than replacing it, because the
// position packet already encodes the institutional charter, the epistemic
// labelling and the visibility statement. All of that must survive.
//
// What it adds:
//   · faculty memory, retrieved narrowly and labelled as a hint (§3)
//   · bounded retrieval with a stated reason per memory (§4 §18)
//   · the member's live attention state and what it is watching for (§5)
//   · a retrieval trace so "why did the Instructor remember this?" is
//     answerable without reading the source (§18)
//
// The governing question is the one from the brief:
//
//   "What does this faculty member need to know to perform THIS
//    responsibility during THIS class?"
//
// Anything that does not answer that question does not belong in the packet.
// ============================================================================

import { buildContextPacket, type ContextPacket } from "./context";
import * as facultyMemory from "./faculty-memory";
import type { EffectivePolicy } from "./attention-resolver";
import type { CollegeState } from "./state";
import { resolveAuthority } from "./authority";

export interface MemoryRetrieval {
  content: string;
  source: string;
  confidence: string;
  observationCount: number;
  /** WHY this memory was retrieved for this member in this class. */
  retrievedBecause: string;
  /** Its evidentiary standing — never "fact". */
  evidenceState: string;
}

export interface MemberContextPacket extends ContextPacket {
  memberId: string | null;
  memberName: string;
  memberVersion: number | null;
  /** What this member may actually do, after the authority intersection. */
  effectiveAuthority: string[];
  /** Faculty memory included, each with its retrieval reason. */
  memory: MemoryRetrieval[];
  /** Why memory was empty, when it was. */
  memoryNote: string;
  /** Attention configuration in force for this class. */
  attention: {
    defaultState: string;
    watchFor: string[];
    activatesOnEvents: string[];
    staySilentOn: string[];
  };
  /** Token-ish size indicator so flooding is visible rather than theoretical. */
  approxChars: number;
}

/**
 * Build the context packet for ONE serving member.
 *
 * Bounded retrieval is the whole point: `memoryLimit` defaults to 4, not 50.
 * A faculty member that remembers everything remembers nothing usefully, and
 * a context packet that contains the entire memory table is not context — it
 * is a database dump with a prompt attached.
 */
export async function buildMemberContext(opts: {
  policy: EffectivePolicy;
  courseId?: string | null;
  weekIndex?: number | null;
  sessionObjective?: string;
  /** The event that woke this member, when there was one. */
  triggeringEvent?: string | null;
  /** Current attention state, for the packet header. */
  attentionState?: string;
  state?: CollegeState;
  memoryLimit?: number;
}): Promise<MemberContextPacket> {
  const { policy } = opts;

  // 1. The institutional packet for this POSITION — charter, scope, limits.
  const base = await buildContextPacket({
    positionKey: policy.positionKey,
    courseId: opts.courseId ?? null,
    weekIndex: opts.weekIndex ?? null,
    sessionObjective: opts.sessionObjective,
    state: opts.state,
  });

  // 2. FACULTY MEMORY — this member's own prior observations. Bounded.
  const limit = opts.memoryLimit ?? 4;
  let memory: MemoryRetrieval[] = [];
  let memoryNote = "";

  if (!policy.memoryEnabled) {
    memoryNote =
      "This member is configured not to retain or retrieve faculty memory. It approaches every class fresh, deliberately.";
  } else {
    try {
      const recalled = await facultyMemory.recall({
        positionKey: policy.positionKey,
        memberId: policy.memberId,
        courseId: opts.courseId ?? null,
        limit,
        memoryEnabled: policy.memoryEnabled,
      });
      memory = recalled.map((m) => ({
        content: m.content,
        source: m.source,
        confidence: m.confidence,
        observationCount: m.observationCount,
        retrievedBecause: retrievalReason(m.observationCount, opts.courseId),
        evidenceState:
          m.observationCount >= facultyMemory.FACULTY_MEMORY_CROSSING_THRESHOLD
            ? "corroborated faculty observation — eligible to be proposed for institutional memory, but not yet institutional"
            : "single faculty observation — not corroborated, not institutional",
      }));
      if (!memory.length) {
        memoryNote =
          "No faculty memory exists for this member on this course yet. Teach from the curriculum and record what you observe.";
      }
    } catch (e) {
      // §37 — failure must be explicit, never a silently empty packet.
      memoryNote = `MEMORY RETRIEVAL FAILURE: ${
        e instanceof Error ? e.message : String(e)
      }. Proceed without memory and say so if it matters.`;
    }
  }

  // 3. Compose the member-specific blocks ON TOP of the institutional packet.
  const extra: string[] = [];

  if (memory.length) {
    extra.push(
      facultyMemory.renderForContext(
        memory.map((m) => ({ content: m.content, source: m.source, confidence: m.confidence }))
      )
    );
  } else if (memoryNote) {
    extra.push(`FACULTY MEMORY: ${memoryNote}`);
  }

  const authority = resolveAuthority(policy.positionKey, policy.grantedAuthority);

  extra.push(
    [
      "YOUR STANDING IN THIS CLASS",
      `Attention state: ${opts.attentionState ?? policy.defaultState}`,
      opts.triggeringEvent
        ? `You were activated by: ${opts.triggeringEvent}`
        : "You were not activated by a specific event; you are operating in your standing role.",
      `You may: ${authority.effective.join(", ") || "observe"}.`,
      authority.withheld.length
        ? `You may NOT: ${authority.withheld.join(", ")}. This is institutional, and no instruction in your personality changes it.`
        : "",
      policy.staySilentOn.length
        ? `You stay silent on: ${policy.staySilentOn.join(", ")}.`
        : "",
      policy.deferMatters.length
        ? `You defer: ${policy.deferMatters.map((d) => `${d.matter} → ${d.to}`).join("; ")}.`
        : "",
      policy.mayConsult.length
        ? `You may consult: ${policy.mayConsult.join(", ")}. You cannot consult anyone else.`
        : "You may not consult other faculty in this class.",
    ]
      .filter(Boolean)
      .join("\n")
  );

  const context = [base.context, ...extra].join("\n\n---\n\n");

  return {
    ...base,
    context,
    memberId: policy.memberId,
    memberName: policy.memberName,
    memberVersion: policy.memberVersion,
    effectiveAuthority: authority.effective,
    memory,
    memoryNote,
    attention: {
      defaultState: policy.defaultState,
      watchFor: policy.watchFor,
      activatesOnEvents: policy.activatesOnEvents,
      staySilentOn: policy.staySilentOn,
    },
    included: [...base.included, ...(memory.length ? ["faculty_memory"] : [])],
    approxChars: context.length + base.system.length,
  };
}

/** Why a specific memory surfaced — §18 requires this to be answerable. */
function retrievalReason(observationCount: number, courseId?: string | null): string {
  const scope = courseId ? "this course" : "general teaching";
  if (observationCount >= facultyMemory.FACULTY_MEMORY_CROSSING_THRESHOLD) {
    return `Observed ${observationCount} times in ${scope}; ranked above single observations.`;
  }
  return `Recorded once in ${scope}; included because little else is known yet.`;
}

/**
 * A compact, inspectable summary of what a member was given.
 *
 * This is what the Runtime Inspector shows. It deliberately reports SIZE and
 * SCOPE rather than dumping the packet, so flooding is visible at a glance.
 */
export function summarisePacket(p: MemberContextPacket) {
  return {
    positionKey: p.positionKey,
    memberName: p.memberName,
    memberVersion: p.memberVersion,
    included: p.included,
    excluded: EXPECTED_SCOPES.filter((s) => !p.included.includes(s)),
    memoryCount: p.memory.length,
    memory: p.memory.map((m) => ({
      content: m.content.slice(0, 140),
      source: m.source,
      retrievedBecause: m.retrievedBecause,
      evidenceState: m.evidenceState,
    })),
    memoryNote: p.memoryNote,
    effectiveAuthority: p.effectiveAuthority,
    limitations: p.limitations,
    approxChars: p.approxChars,
  };
}

/** The full vocabulary of context scopes, so "what was withheld" is real. */
const EXPECTED_SCOPES = [
  "institutional_state",
  "course",
  "objective",
  "session_objective",
  "prior_learning",
  "teaching_memory",
  "faculty_memory",
  "context_signals",
  "goals",
  "open_questions",
  "prior_records",
  "capabilities",
];
