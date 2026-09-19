import "server-only";

import { db } from "@/db";
import { collegeAttentionDecisions, collegeFacultyMembers } from "@/db/college";
import { and, desc, eq } from "drizzle-orm";
import {
  getAttentionPolicy,
  type AttentionPolicy,
  type AttentionPriority,
  type InterruptionAuthority,
} from "./attention";
import { getFacultyPosition } from "./faculty";
import { resolveFacultyForContext, type ResolvedMember } from "./members";

/**
 * LAYER 5 — configuration must GOVERN runtime.
 *
 * Before this module, the orchestrator asked `getAttentionPolicy(positionKey)`
 * and got a hardcoded answer. A founder could configure a faculty member in the
 * Builder and the runtime would quietly ignore it.
 *
 * This resolver replaces that lookup. It composes the effective attention
 * policy from the configuration layers in precedence order, and — critically —
 * records WHICH layer decided each field, so the founder can always see why a
 * member behaved the way it did.
 *
 * PRECEDENCE (most specific wins):
 *
 *   session          explicit session-scoped assignment
 *   course           course-scoped assignment
 *   position         the institutional position's policy
 *   member           the configured member's own settings
 *   institutional    the built-in default
 *
 * Note the deliberate ordering of `position` above `member`: a member may
 * narrow what it does, but may never widen beyond what the position permits.
 * Authority flows from the position; personality and preference flow from the
 * member. That asymmetry is the whole point.
 *
 * A configuration value counts as PRESENT only when it is genuinely set. An
 * empty array or empty string means "not configured", and the next layer down
 * legitimately applies. We never treat an empty configuration as an intentional
 * instruction to do nothing.
 */

// ---------------------------------------------------------------------------
// Runtime attention states
// ---------------------------------------------------------------------------

export const RUNTIME_ATTENTION_STATES = [
  "dormant",
  "watching",
  "attentive",
  "consulting",
  "speaking",
  "deferred",
  "escalated",
] as const;

export type RuntimeAttentionState = (typeof RUNTIME_ATTENTION_STATES)[number];

export const STATE_MEANING: Record<RuntimeAttentionState, string> = {
  dormant: "Not attending. Will not see events unless a trigger wakes it.",
  watching: "Attending silently. Sees events, records nothing, says nothing.",
  attentive: "Actively tracking a matter within its remit. May act.",
  consulting: "Engaged with another position, not with the student.",
  speaking: "Producing output the student will see.",
  deferred: "Has explicitly handed this matter to another position.",
  escalated: "Has raised the matter above its own authority.",
};

export type ResolvedAction =
  | "ignore"
  | "notice"
  | "activate"
  | "consult"
  | "defer"
  | "escalate"
  | "speak";

/** Which configuration layer supplied a value. */
export type DecidedBy = "session" | "course" | "position" | "member" | "institutional_default";

export interface ProvenanceEntry {
  field: string;
  decidedBy: DecidedBy;
  value: string;
  note?: string;
}

/**
 * The effective policy actually used at runtime, plus a full record of where
 * each field came from.
 */
export interface EffectivePolicy {
  positionKey: string;
  memberId: string | null;
  memberName: string;
  memberVersion: number | null;
  watchFor: string[];
  activatesOnEvents: string[];
  activatesOnPhases: string[];
  staySilentOn: string[];
  escalateOn: string[];
  stopAttendingOn: string[];
  deferMatters: Array<{ matter: string; to: string }>;
  mayConsult: string[];
  mayHandOffTo: string[];
  interruptionAuthority: InterruptionAuthority;
  defaultState: RuntimeAttentionState;
  relevantPhases: string[];
  memoryEnabled: boolean;
  memoryScopeLimit: string;
  provenance: ProvenanceEntry[];
  /** True when a configured member supplied at least one field. */
  configurationApplied: boolean;
}

const jsonArray = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const jsonPairs = (raw: string | null | undefined): Array<{ matter: string; to: string }> => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => ({ matter: String(x?.matter ?? ""), to: String(x?.to ?? "") }))
      .filter((x) => x.matter && x.to);
  } catch {
    return [];
  }
};

/**
 * Compose the effective policy for one position in one context.
 *
 * `member` may be null — a position with no configured member falls back
 * entirely to institutional defaults, which is a legitimate state, not an error.
 */
export function composePolicy(
  positionKey: string,
  member: ResolvedMember | null,
  opts: { scope?: string } = {}
): EffectivePolicy {
  const policy: AttentionPolicy | undefined = getAttentionPolicy(positionKey);
  const provenance: ProvenanceEntry[] = [];
  const m = member?.member ?? null;

  // The scope the member was assigned at determines whether its configuration
  // counts as session-level, course-level, or plain member-level.
  const scope = opts.scope ?? member?.scope ?? "";
  const configLayer: DecidedBy =
    scope === "session" ? "session" : scope === "course" ? "course" : "member";

  /**
   * Take the member's value when it is genuinely configured; otherwise fall
   * back to the position policy, and finally to the institutional default.
   */
  function pick<T>(
    field: string,
    memberValue: T | null,
    policyValue: T | null,
    fallback: T,
    present: (v: T | null) => boolean
  ): T {
    if (present(memberValue)) {
      provenance.push({
        field,
        decidedBy: configLayer,
        value: JSON.stringify(memberValue),
        note: `Explicitly configured on member "${m?.name ?? "?"}".`,
      });
      return memberValue as T;
    }
    if (present(policyValue)) {
      provenance.push({
        field,
        decidedBy: "position",
        value: JSON.stringify(policyValue),
        note: "No member configuration; the position's institutional policy applies.",
      });
      return policyValue as T;
    }
    provenance.push({
      field,
      decidedBy: "institutional_default",
      value: JSON.stringify(fallback),
      note: "Neither member nor position configured this; the College default applies.",
    });
    return fallback;
  }

  const arrPresent = (v: string[] | null) => Array.isArray(v) && v.length > 0;
  const pairsPresent = (v: Array<{ matter: string; to: string }> | null) =>
    Array.isArray(v) && v.length > 0;
  const strPresent = (v: string | null) => typeof v === "string" && v.trim().length > 0;

  const watchFor = pick<string[]>(
    "watchFor",
    m ? jsonArray(m.watchFor) : null,
    policy ? policy.relevantEvidence : null,
    [],
    arrPresent
  );

  const activatesOnEvents = pick<string[]>(
    "activatesOnEvents",
    m ? jsonArray(m.activatesOnEvents) : null,
    policy ? policy.triggers.map((t) => t.event) : null,
    [],
    arrPresent
  );

  const activatesOnPhases = pick<string[]>(
    "activatesOnPhases",
    m ? jsonArray(m.activatesOnPhases) : null,
    policy ? policy.relevantPhases : null,
    [],
    arrPresent
  );

  const staySilentOn = pick<string[]>(
    "staySilentOn",
    m ? jsonArray(m.staySilentOn) : null,
    policy ? policy.silenceConditions : null,
    [],
    arrPresent
  );

  const escalateOn = pick<string[]>(
    "escalateOn",
    m ? jsonArray(m.escalateOn) : null,
    policy ? policy.escalationConditions : null,
    [],
    arrPresent
  );

  const stopAttendingOn = pick<string[]>(
    "stopAttendingOn",
    m ? jsonArray(m.stopAttendingOn) : null,
    policy ? policy.observationOnly : null,
    [],
    arrPresent
  );

  const deferMatters = pick<Array<{ matter: string; to: string }>>(
    "deferMatters",
    m ? jsonPairs(m.deferMatters) : null,
    policy ? policy.deferMatters : null,
    [],
    pairsPresent
  );

  // Coordination network. The member may NARROW the position's network but
  // never extend it — consulting someone the position may not consult would be
  // configuration granting authority, which is exactly what must not happen.
  const policyConsult = policy?.mayConsult ?? [];
  const memberConsultRaw = m ? jsonArray(m.canConsult) : [];
  const memberConsult = memberConsultRaw.filter((x) => policyConsult.includes(x));
  const consultRefused = memberConsultRaw.filter((x) => !policyConsult.includes(x));
  const mayConsult = pick<string[]>(
    "mayConsult",
    memberConsult.length ? memberConsult : null,
    policyConsult.length ? policyConsult : null,
    [],
    arrPresent
  );
  if (consultRefused.length) {
    provenance.push({
      field: "mayConsult.refused",
      decidedBy: "position",
      value: JSON.stringify(consultRefused),
      note: `The position does not permit consulting ${consultRefused.join(", ")}. Configuration may narrow the coordination network, never widen it.`,
    });
  }

  const policyHandoff = policy?.mayHandOffTo ?? [];
  const memberHandoffRaw = m ? jsonArray(m.canHandOffTo) : [];
  const memberHandoff = memberHandoffRaw.filter((x) => policyHandoff.includes(x));
  const mayHandOffTo = pick<string[]>(
    "mayHandOffTo",
    memberHandoff.length ? memberHandoff : null,
    policyHandoff.length ? policyHandoff : null,
    [],
    arrPresent
  );

  // Interruption authority. A member may LOWER its own interruption authority
  // but never raise it above the position's ceiling.
  const ladder: InterruptionAuthority[] = ["none", "request", "material", "integrity"];
  const policyInterrupt: InterruptionAuthority = policy?.interruptionAuthority ?? "none";
  const memberInterruptRaw = (m?.interruptionAuthority ?? "").trim() as InterruptionAuthority;
  let interruptionAuthority: InterruptionAuthority;
  if (memberInterruptRaw && ladder.includes(memberInterruptRaw)) {
    const memberIdx = ladder.indexOf(memberInterruptRaw);
    const ceilingIdx = ladder.indexOf(policyInterrupt);
    if (memberIdx <= ceilingIdx) {
      interruptionAuthority = memberInterruptRaw;
      provenance.push({
        field: "interruptionAuthority",
        decidedBy: configLayer,
        value: memberInterruptRaw,
        note: "Configured at or below the position's ceiling.",
      });
    } else {
      interruptionAuthority = policyInterrupt;
      provenance.push({
        field: "interruptionAuthority",
        decidedBy: "position",
        value: policyInterrupt,
        note: `Requested "${memberInterruptRaw}" exceeds the position's ceiling "${policyInterrupt}". Configuration cannot raise interruption authority.`,
      });
    }
  } else {
    interruptionAuthority = policyInterrupt;
    provenance.push({
      field: "interruptionAuthority",
      decidedBy: "position",
      value: policyInterrupt,
      note: "Not configured on the member; the position's authority applies.",
    });
  }

  const rawDefault = (m?.defaultState ?? "").trim();
  const defaultState = (
    RUNTIME_ATTENTION_STATES.includes(rawDefault as RuntimeAttentionState)
      ? rawDefault
      : normaliseState(policy?.defaultState ?? "dormant")
  ) as RuntimeAttentionState;
  provenance.push({
    field: "defaultState",
    decidedBy: rawDefault ? configLayer : policy ? "position" : "institutional_default",
    value: defaultState,
  });

  return {
    positionKey,
    memberId: m?.id ?? null,
    memberName: m?.name ?? "",
    memberVersion: m?.version ?? null,
    watchFor,
    activatesOnEvents,
    activatesOnPhases,
    staySilentOn,
    escalateOn,
    stopAttendingOn,
    deferMatters,
    mayConsult,
    mayHandOffTo,
    interruptionAuthority,
    defaultState,
    relevantPhases: activatesOnPhases,
    memoryEnabled: m ? m.memoryEnabled : true,
    memoryScopeLimit: m?.memoryScopeLimit ?? "course",
    provenance,
    configurationApplied: provenance.some((p) => p.decidedBy === configLayer),
  };
}

/** Older policy states used slightly different words. Map them forward. */
function normaliseState(s: string): RuntimeAttentionState {
  if (s === "engaged") return "attentive";
  if (RUNTIME_ATTENTION_STATES.includes(s as RuntimeAttentionState)) {
    return s as RuntimeAttentionState;
  }
  return "dormant";
}

/**
 * Resolve effective policies for every position relevant to a context.
 * Returns a map keyed by positionKey.
 */
export async function effectivePolicies(ctx: {
  courseId?: string | null;
  sessionKind?: string;
  slotId?: string | null;
  positions?: string[];
}): Promise<Map<string, EffectivePolicy>> {
  const members = await resolveFacultyForContext({
    courseId: ctx.courseId ?? null,
    sessionKind: ctx.sessionKind,
    slotId: ctx.slotId ?? null,
  });

  const byPosition = new Map<string, ResolvedMember>();
  for (const m of members) byPosition.set(m.member.positionKey, m);

  const keys = new Set<string>([...byPosition.keys(), ...(ctx.positions ?? [])]);
  const out = new Map<string, EffectivePolicy>();
  for (const k of keys) {
    out.set(k, composePolicy(k, byPosition.get(k) ?? null));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event evaluation — the part that actually governs runtime
// ---------------------------------------------------------------------------

export interface AttentionOutcome {
  positionKey: string;
  memberId: string | null;
  memberName: string;
  state: RuntimeAttentionState;
  action: ResolvedAction;
  reason: string;
  decidedBy: DecidedBy;
  priority: AttentionPriority;
  /** Who this matter was deferred to, when action === "defer". */
  deferTo?: string;
}

/**
 * Evaluate ONE event against ONE member's effective policy.
 *
 * This is deliberately deterministic and inspectable. No model call decides
 * whether a faculty member pays attention — the configuration does.
 */
export function evaluateAttention(
  policy: EffectivePolicy,
  event: { eventType: string; phaseKey?: string; payload?: string }
): AttentionOutcome {
  const position = getFacultyPosition(policy.positionKey);
  const name = policy.memberName || position?.name || policy.positionKey;
  const layer: DecidedBy = policy.configurationApplied ? "member" : "position";

  const base = {
    positionKey: policy.positionKey,
    memberId: policy.memberId,
    memberName: policy.memberName,
  };

  // 1. STOP ATTENDING — an explicit exit condition outranks everything else.
  if (policy.stopAttendingOn.some((c) => matches(c, event))) {
    return {
      ...base,
      state: "dormant",
      action: "ignore",
      reason: `${name} stops attending on this condition.`,
      decidedBy: layer,
      priority: "low",
    };
  }

  // 2. DEFERRAL — is this matter explicitly someone else's?
  const deferral = policy.deferMatters.find((d) => matches(d.matter, event));
  if (deferral) {
    return {
      ...base,
      state: "deferred",
      action: "defer",
      reason: `${name} defers this matter to ${deferral.to}: "${deferral.matter}". Deferral is successful coordination, not failure.`,
      decidedBy: layer,
      priority: "normal",
      deferTo: deferral.to,
    };
  }

  // 3. ESCALATION — above this member's authority.
  if (policy.escalateOn.some((c) => matches(c, event))) {
    return {
      ...base,
      state: "escalated",
      action: "escalate",
      reason: `${name} escalates rather than acting alone; the matter exceeds its authority.`,
      decidedBy: layer,
      priority: "high",
    };
  }

  // 4. ACTIVATION — the configured trigger list governs.
  const activates = policy.activatesOnEvents.includes(event.eventType);
  const phaseOk =
    !event.phaseKey ||
    policy.activatesOnPhases.length === 0 ||
    policy.activatesOnPhases.includes(event.phaseKey);

  if (activates && phaseOk) {
    // 5. SILENCE — configured to attend but not speak.
    if (policy.staySilentOn.some((c) => matches(c, event))) {
      return {
        ...base,
        state: "watching",
        action: "notice",
        reason: `${name} attends but stays silent under this condition.`,
        decidedBy: layer,
        priority: "normal",
      };
    }
    return {
      ...base,
      state: "attentive",
      action: "activate",
      reason: `"${event.eventType}" is a configured activation trigger for ${name}.`,
      decidedBy: layer,
      priority: "normal",
    };
  }

  if (activates && !phaseOk) {
    return {
      ...base,
      state: "watching",
      action: "notice",
      reason: `${name} is triggered by "${event.eventType}" but not during the "${event.phaseKey}" phase.`,
      decidedBy: layer,
      priority: "low",
    };
  }

  // 6. WATCHING — within scope but not an activation trigger.
  if (policy.watchFor.some((w) => matches(w, event))) {
    return {
      ...base,
      state: "watching",
      action: "notice",
      reason: `${name} watches for this but does not activate on it.`,
      decidedBy: layer,
      priority: "low",
    };
  }

  // 7. DORMANT — genuinely outside this member's remit.
  return {
    ...base,
    state: "dormant",
    action: "ignore",
    reason: `"${event.eventType}" is outside ${name}'s configured attention.`,
    decidedBy: layer,
    priority: "low",
  };
}

/**
 * Loose match between a configured condition (written in institutional
 * language) and an event. Conditions may be event keys or prose.
 */
function matches(condition: string, event: { eventType: string; payload?: string }): boolean {
  const c = condition.toLowerCase().trim();
  if (!c) return false;
  if (c === event.eventType.toLowerCase()) return true;
  // Allow prose conditions to reference the event type loosely.
  const evWords = event.eventType.toLowerCase().split("_").filter((w) => w.length > 3);
  if (evWords.length && evWords.every((w) => c.includes(w))) return true;
  return false;
}

/**
 * Resolve speaking order. Never "whichever model returned first".
 *
 *   1. mandatory responsibilities
 *   2. safety / authority constraints
 *   3. primary instructional responsibility
 *   4. relevant specialist input
 *   5. coordination
 *   6. final student-facing response
 */
const ORDER_RANK: Record<string, number> = {
  registrar: 1, // institutional integrity first
  observer: 2, // records before interpretation
  critic: 3, // challenge before delivery
  researcher: 3,
  specialist: 4,
  socratic: 4,
  assessor: 4,
  instructor: 9, // the instructor speaks LAST, to the student
};

export function resolveSpeakingOrder(outcomes: AttentionOutcome[]): AttentionOutcome[] {
  return [...outcomes].sort((a, b) => {
    const ra = ORDER_RANK[a.positionKey] ?? 5;
    const rb = ORDER_RANK[b.positionKey] ?? 5;
    if (ra !== rb) return ra - rb;
    return a.positionKey.localeCompare(b.positionKey);
  });
}

/** Persist an attention decision so the founder can inspect why it happened. */
export async function recordAttentionDecision(input: {
  sessionId: string;
  eventId?: string | null;
  eventType: string;
  outcome: AttentionOutcome;
  provenance: ProvenanceEntry[];
}) {
  await db.insert(collegeAttentionDecisions).values({
    sessionId: input.sessionId,
    eventId: input.eventId ?? null,
    eventType: input.eventType,
    positionKey: input.outcome.positionKey,
    memberId: input.outcome.memberId,
    memberName: input.outcome.memberName,
    resolvedState: input.outcome.state,
    action: input.outcome.action,
    reason: input.outcome.reason,
    decidedBy: input.outcome.decidedBy,
    provenance: JSON.stringify(input.provenance.slice(0, 40)),
  });
}

/** Read back the decisions for a session, for the runtime inspector. */
export async function attentionDecisions(sessionId: string) {
  return db
    .select()
    .from(collegeAttentionDecisions)
    .where(eq(collegeAttentionDecisions.sessionId, sessionId))
    .orderBy(desc(collegeAttentionDecisions.createdAt));
}

/** Look up a single member's live configuration row. */
export async function memberById(id: string) {
  const [row] = await db
    .select()
    .from(collegeFacultyMembers)
    .where(and(eq(collegeFacultyMembers.id, id), eq(collegeFacultyMembers.status, "active")))
    .limit(1);
  return row ?? null;
}
