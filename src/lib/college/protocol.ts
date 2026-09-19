// ============================================================================
// Lochie Life College — Course faculty protocols (SERVER ONLY)
// ============================================================================
// A course declares which faculty positions are relevant to it and under what
// conditions they activate. Attention is CONFIGURATION, not code.
//
// PSY110 may run Instructor-primary with continuous Observer and a conditional
// Critic. Another course may be structured completely differently. Neither is
// hardcoded into the class runner.
// ============================================================================

import { db } from "@/db";
import { collegeFacultyProtocols } from "@/db/college";
import { and, eq, isNull } from "drizzle-orm";
import { SESSION_PHASES, getAttentionPolicy } from "./attention";
import { getFacultyPosition } from "./faculty";

/** How a position participates in a given course. */
export type ProtocolMode =
  /** Leads the session. */
  | "primary"
  /** Attends throughout, speaks rarely. */
  | "continuous"
  /** Dormant until a declared condition occurs. */
  | "conditional"
  /** Not in class; invoked post-session. */
  | "administrative";

export interface ProtocolPosition {
  positionKey: string;
  mode: ProtocolMode;
  /** Event types that activate a conditional position. */
  activatesOn: string[];
  reason: string;
}

export interface PhasePlanEntry {
  phaseKey: string;
  primary: string[];
  watching: string[];
}

export interface FacultyProtocol {
  id: string | null;
  courseId: string | null;
  sessionKind: string;
  label: string;
  positions: ProtocolPosition[];
  phasePlan: PhasePlanEntry[];
  isDefault: boolean;
}

/**
 * The College default protocol. Used when a course has not declared its own.
 * This is a DEFAULT, not a universal rule — every value here is overridable.
 */
export const DEFAULT_PROTOCOL_POSITIONS: ProtocolPosition[] = [
  {
    positionKey: "instructor",
    mode: "primary",
    activatesOn: [],
    reason: "Leads teaching against the active objective.",
  },
  {
    positionKey: "observer",
    mode: "continuous",
    activatesOn: [],
    reason: "Records what actually happens throughout the session.",
  },
  {
    positionKey: "critic",
    mode: "conditional",
    activatesOn: ["contradiction_detected", "misconception_detected", "decision_proposed"],
    reason: "Activated when a genuine reasoning problem appears.",
  },
  {
    positionKey: "researcher",
    mode: "conditional",
    activatesOn: ["factual_uncertainty_detected", "research_required"],
    reason: "Activated when factual verification is required.",
  },
  {
    positionKey: "registrar",
    mode: "administrative",
    activatesOn: ["record_worthy_event_detected", "decision_accepted"],
    reason: "Invoked at session close or on a record-worthy event. Does not attend class.",
  },
];

function defaultPhasePlan(): PhasePlanEntry[] {
  return SESSION_PHASES.map((p) => ({
    phaseKey: p.key,
    primary: [...p.defaultPrimary],
    watching: [...p.defaultWatching],
  }));
}

export function collegeDefaultProtocol(sessionKind = ""): FacultyProtocol {
  return {
    id: null,
    courseId: null,
    sessionKind,
    label: "College default protocol",
    positions: DEFAULT_PROTOCOL_POSITIONS,
    phasePlan: defaultPhasePlan(),
    isDefault: true,
  };
}

function parseProtocol(row: {
  id: string;
  courseId: string | null;
  sessionKind: string;
  label: string;
  positions: string;
  phasePlan: string;
}): FacultyProtocol {
  let positions: ProtocolPosition[] = [];
  let phasePlan: PhasePlanEntry[] = [];
  try {
    positions = JSON.parse(row.positions);
  } catch {
    positions = DEFAULT_PROTOCOL_POSITIONS;
  }
  try {
    phasePlan = JSON.parse(row.phasePlan);
  } catch {
    phasePlan = defaultPhasePlan();
  }
  if (!Array.isArray(positions) || !positions.length) positions = DEFAULT_PROTOCOL_POSITIONS;
  if (!Array.isArray(phasePlan) || !phasePlan.length) phasePlan = defaultPhasePlan();
  return {
    id: row.id,
    courseId: row.courseId,
    sessionKind: row.sessionKind,
    label: row.label,
    positions,
    phasePlan,
    isDefault: false,
  };
}

/**
 * Resolve the protocol governing a session: course+kind, then course, then
 * College default. Never throws — a missing protocol is not an error, it just
 * means the College default applies.
 */
export async function resolveProtocol(
  courseId: string | null,
  sessionKind: string
): Promise<FacultyProtocol> {
  if (courseId) {
    const exact = await db
      .select()
      .from(collegeFacultyProtocols)
      .where(
        and(
          eq(collegeFacultyProtocols.courseId, courseId),
          eq(collegeFacultyProtocols.sessionKind, sessionKind),
          eq(collegeFacultyProtocols.active, true)
        )
      )
      .limit(1);
    if (exact.length) return parseProtocol(exact[0]);

    const anyKind = await db
      .select()
      .from(collegeFacultyProtocols)
      .where(
        and(
          eq(collegeFacultyProtocols.courseId, courseId),
          eq(collegeFacultyProtocols.sessionKind, ""),
          eq(collegeFacultyProtocols.active, true)
        )
      )
      .limit(1);
    if (anyKind.length) return parseProtocol(anyKind[0]);
  }

  const collegeWide = await db
    .select()
    .from(collegeFacultyProtocols)
    .where(and(isNull(collegeFacultyProtocols.courseId), eq(collegeFacultyProtocols.active, true)))
    .limit(1);
  if (collegeWide.length) return parseProtocol(collegeWide[0]);

  return collegeDefaultProtocol(sessionKind);
}

export async function saveProtocol(input: {
  courseId: string | null;
  sessionKind?: string;
  label: string;
  positions: ProtocolPosition[];
  phasePlan?: PhasePlanEntry[];
  reason: string;
}): Promise<{ ok: true; protocol: FacultyProtocol } | { ok: false; error: string }> {
  // Validate before persisting — a protocol that violates the branch split or
  // an attention policy must not be storable.
  for (const p of input.positions) {
    const position = getFacultyPosition(p.positionKey);
    if (!position) return { ok: false, error: `Unknown position "${p.positionKey}".` };
    if (position.branch === "administration" && p.mode !== "administrative") {
      return {
        ok: false,
        error: `${position.name} is administration and may only be declared "administrative". Administration does not attend teaching sessions.`,
      };
    }
    if (position.branch === "faculty" && p.mode === "administrative") {
      return {
        ok: false,
        error: `${position.name} is teaching faculty and cannot be declared administrative. Faculty must not silently acquire record-keeping authority.`,
      };
    }
    const policy = getAttentionPolicy(p.positionKey);
    if (policy && p.mode === "conditional" && !p.activatesOn.length) {
      return {
        ok: false,
        error: `${position.name} is conditional but declares no activation conditions. A conditional position that never activates is a dormant position.`,
      };
    }
  }

  const existing = input.courseId
    ? await db
        .select()
        .from(collegeFacultyProtocols)
        .where(
          and(
            eq(collegeFacultyProtocols.courseId, input.courseId),
            eq(collegeFacultyProtocols.sessionKind, input.sessionKind ?? "")
          )
        )
        .limit(1)
    : await db
        .select()
        .from(collegeFacultyProtocols)
        .where(isNull(collegeFacultyProtocols.courseId))
        .limit(1);

  if (existing.length) {
    const [row] = await db
      .update(collegeFacultyProtocols)
      .set({
        label: input.label.slice(0, 200),
        positions: JSON.stringify(input.positions),
        phasePlan: JSON.stringify(input.phasePlan ?? defaultPhasePlan()),
        reason: input.reason.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(collegeFacultyProtocols.id, existing[0].id))
      .returning();
    return { ok: true, protocol: parseProtocol(row) };
  }

  const [row] = await db
    .insert(collegeFacultyProtocols)
    .values({
      courseId: input.courseId,
      sessionKind: input.sessionKind ?? "",
      label: input.label.slice(0, 200),
      positions: JSON.stringify(input.positions),
      phasePlan: JSON.stringify(input.phasePlan ?? defaultPhasePlan()),
      reason: input.reason.slice(0, 2000),
    })
    .returning();
  return { ok: true, protocol: parseProtocol(row) };
}

/** Positions that open the session in a non-dormant state. */
export function initialRoster(protocol: FacultyProtocol): Array<{
  positionKey: string;
  state: string;
  reason: string;
}> {
  return protocol.positions
    .filter((p) => p.mode !== "administrative")
    .map((p) => {
      if (p.mode === "primary") {
        return { positionKey: p.positionKey, state: "engaged", reason: p.reason };
      }
      if (p.mode === "continuous") {
        return { positionKey: p.positionKey, state: "watching", reason: p.reason };
      }
      return {
        positionKey: p.positionKey,
        state: "dormant",
        reason: `${p.reason} Currently dormant; activates on: ${p.activatesOn.join(", ") || "(nothing declared)"}.`,
      };
    });
}

/** Which positions a phase makes primary / watching, per the protocol. */
export function phaseRoster(
  protocol: FacultyProtocol,
  phaseKey: string
): { primary: string[]; watching: string[] } {
  const entry = protocol.phasePlan.find((p) => p.phaseKey === phaseKey);
  if (entry) return { primary: entry.primary, watching: entry.watching };
  const fallback = SESSION_PHASES.find((p) => p.key === phaseKey);
  return {
    primary: fallback ? [...fallback.defaultPrimary] : [],
    watching: fallback ? [...fallback.defaultWatching] : [],
  };
}
