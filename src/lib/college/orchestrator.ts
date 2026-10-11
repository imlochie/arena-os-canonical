// ============================================================================
// Lochie Life College — Faculty orchestrator (SERVER ONLY)
// ============================================================================
// The orchestration system decides WHEN a faculty role should operate. The AI
// is merely an implementation of that role at a bounded execution point.
//
// This module owns:
//   · session phases          — what kind of moment is this?
//   · the event bus           — what just happened?
//   · attention routing       — whose remit does it fall in?
//   · attention state         — dormant / watching / engaged / ...
//   · consultations           — one position formally asking another
//   · handoffs                — deliberate transfer of responsibility
//   · interruption governance — who may cut in, and why
//   · the coordination trace  — structured provenance, never chain-of-thought
//
// It does NOT generate text. `teaching.ts` does that, only where this module
// has decided a position should speak.
// ============================================================================

import { db } from "@/db";
import {
  collegeConsultations,
  collegeFacultyAttention,
  collegeHandoffs,
  collegeInterruptions,
  collegeSessionEventBus,
  collegeSessionEvents,
  collegeSessionPhases,
} from "@/db/college";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  evaluateTrigger,
  getAttentionPolicy,
  mayConsult as policyMayConsult,
  mayHandOff as policyMayHandOff,
  mayInterrupt,
  maxPriority,
  stateSpeaks,
  type AttentionPriority,
} from "./attention";
import { getFacultyPosition } from "./faculty";
import {
  effectivePolicies,
  evaluateAttention,
  recordAttentionDecision,
} from "./attention-resolver";
import { phaseRoster, type FacultyProtocol } from "./protocol";

// ---------------------------------------------------------------------------
// Attention state
// ---------------------------------------------------------------------------

export interface AttentionRecord {
  positionKey: string;
  name: string;
  state: string;
  reason: string;
  phaseKey: string;
  spoke: boolean;
}

/**
 * Transition a position's attention state. Every transition records WHY.
 * Append-only: we never overwrite the previous state, we record the change.
 */
export async function setAttention(opts: {
  sessionId: string;
  positionKey: string;
  state: string;
  reason: string;
  phaseKey?: string;
  triggeredByEventId?: string | null;
  spoke?: boolean;
}): Promise<AttentionRecord | null> {
  const position = getFacultyPosition(opts.positionKey);
  if (!position) return null;

  const [current] = await db
    .select()
    .from(collegeFacultyAttention)
    .where(
      and(
        eq(collegeFacultyAttention.sessionId, opts.sessionId),
        eq(collegeFacultyAttention.positionKey, opts.positionKey)
      )
    )
    .orderBy(desc(collegeFacultyAttention.createdAt))
    .limit(1);

  const previousState = current?.state ?? "";
  if (previousState === opts.state && !opts.spoke) {
    // No genuine change — do not pad the trace with noise.
    return {
      positionKey: opts.positionKey,
      name: position.name,
      state: opts.state,
      reason: current?.reason ?? opts.reason,
      phaseKey: current?.phaseKey ?? opts.phaseKey ?? "",
      spoke: current?.spoke ?? false,
    };
  }

  const [row] = await db
    .insert(collegeFacultyAttention)
    .values({
      sessionId: opts.sessionId,
      positionKey: opts.positionKey,
      state: opts.state,
      previousState,
      reason: opts.reason.slice(0, 2000),
      phaseKey: opts.phaseKey ?? "",
      triggeredByEventId: opts.triggeredByEventId ?? null,
      spoke: opts.spoke ?? false,
    })
    .returning();

  return {
    positionKey: row.positionKey,
    name: position.name,
    state: row.state,
    reason: row.reason,
    phaseKey: row.phaseKey,
    spoke: row.spoke,
  };
}

/** Current attention state of every position in a session. */
export async function currentAttention(sessionId: string): Promise<AttentionRecord[]> {
  const rows = await db
    .select()
    .from(collegeFacultyAttention)
    .where(eq(collegeFacultyAttention.sessionId, sessionId))
    .orderBy(asc(collegeFacultyAttention.createdAt));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.positionKey, r);

  return [...latest.values()].map((r) => ({
    positionKey: r.positionKey,
    name: getFacultyPosition(r.positionKey)?.name ?? r.positionKey,
    state: r.state,
    reason: r.reason,
    phaseKey: r.phaseKey,
    spoke: r.spoke,
  }));
}

/**
 * The coordination state other faculty are allowed to see.
 * Structured status only — never another position's hidden reasoning.
 */
export async function coordinationBoard(sessionId: string): Promise<string> {
  const attention = await currentAttention(sessionId);
  if (!attention.length) return "";
  const open = await db
    .select()
    .from(collegeConsultations)
    .where(
      and(eq(collegeConsultations.sessionId, sessionId), eq(collegeConsultations.status, "open"))
    );

  const lines = attention.map((a) => {
    const waiting = open.find((c) => c.requestingPosition === a.positionKey);
    const asked = open.find((c) => c.requestedPosition === a.positionKey);
    const flags: string[] = [];
    if (waiting) flags.push(`awaiting ${waiting.requestedPosition}`);
    if (asked) flags.push(`consultation requested by ${asked.requestingPosition}`);
    return `  ${a.name} — ${a.state.toUpperCase()}${flags.length ? ` (${flags.join("; ")})` : ""}`;
  });

  return [
    "CURRENT FACULTY COORDINATION STATE",
    "(Structured status only. You do not see other positions' reasoning.)",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export async function enterPhase(opts: {
  sessionId: string;
  phaseKey: string;
  protocol: FacultyProtocol;
  note?: string;
}): Promise<{ phaseKey: string; primary: string[]; watching: string[] }> {
  const { primary, watching } = phaseRoster(opts.protocol, opts.phaseKey);

  // Close the previous phase.
  await db
    .update(collegeSessionPhases)
    .set({ exitedAt: new Date() })
    .where(
      and(
        eq(collegeSessionPhases.sessionId, opts.sessionId),
        sql`${collegeSessionPhases.exitedAt} is null`
      )
    );

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collegeSessionPhases)
    .where(eq(collegeSessionPhases.sessionId, opts.sessionId));

  await db.insert(collegeSessionPhases).values({
    sessionId: opts.sessionId,
    phaseKey: opts.phaseKey,
    sequence: Number(count) + 1,
    primaryPositions: JSON.stringify(primary),
    watchingPositions: JSON.stringify(watching),
    note: (opts.note ?? "").slice(0, 2000),
  });

  // Phase change is itself an event.
  await emitEvent({
    sessionId: opts.sessionId,
    eventType: "session_phase_changed",
    payload: `Phase → ${opts.phaseKey}`,
    emittedBy: "system",
    phaseKey: opts.phaseKey,
    protocol: opts.protocol,
  });

  // Move faculty into the states the phase requires.
  const conditional = new Set(
    opts.protocol.positions.filter((p) => p.mode === "conditional").map((p) => p.positionKey)
  );

  for (const key of primary) {
    const position = getFacultyPosition(key);
    if (!position) continue;
    // Administration is never activated by a teaching phase.
    if (position.branch === "administration" && opts.phaseKey !== "institutional_record") continue;
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: key,
      state: "engaged",
      reason: `Phase "${opts.phaseKey}" makes this position primary.`,
      phaseKey: opts.phaseKey,
    });
  }
  for (const key of watching) {
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: key,
      state: "watching",
      reason: `Phase "${opts.phaseKey}" makes this position relevant but not speaking.`,
      phaseKey: opts.phaseKey,
    });
  }

  // Conditional positions not named by the phase return to dormancy.
  const active = new Set([...primary, ...watching]);
  for (const key of conditional) {
    if (active.has(key)) continue;
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: key,
      state: "dormant",
      reason: `Not relevant to phase "${opts.phaseKey}". Returning to dormant.`,
      phaseKey: opts.phaseKey,
    });
  }

  return { phaseKey: opts.phaseKey, primary, watching };
}

export async function currentPhase(sessionId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(collegeSessionPhases)
    .where(eq(collegeSessionPhases.sessionId, sessionId))
    .orderBy(desc(collegeSessionPhases.sequence))
    .limit(1);
  return row?.phaseKey ?? "";
}

// ---------------------------------------------------------------------------
// The event bus
// ---------------------------------------------------------------------------

export interface RoutedPosition {
  positionKey: string;
  name: string;
  priority: AttentionPriority;
  because: string;
  action: "activate" | "note" | "consult" | "interrupt";
  newState: string;
}

export interface EmitResult {
  eventId: string;
  eventType: string;
  routed: RoutedPosition[];
  ignoredBy: Array<{ positionKey: string; reason: string }>;
}

/**
 * Emit a session event and route it. A position wakes because the event falls
 * within its remit — never because "the AI was asked to answer".
 *
 * Positions with no trigger for this event are explicitly recorded as having
 * ignored it. Silence is a decision the College can account for.
 */
export async function emitEvent(opts: {
  sessionId: string;
  eventType: string;
  payload?: string;
  emittedBy?: string;
  phaseKey?: string;
  protocol: FacultyProtocol;
  /**
   * LAYER 5 — context needed to resolve the CONFIGURED faculty member for each
   * position. When supplied, member configuration governs routing. When absent,
   * the institutional position policy applies, which is a genuine fallback
   * rather than a silent override.
   */
  courseId?: string | null;
  sessionKind?: string;
  slotId?: string | null;
}): Promise<EmitResult> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collegeSessionEventBus)
    .where(eq(collegeSessionEventBus.sessionId, opts.sessionId));

  const routed: RoutedPosition[] = [];
  const ignoredBy: Array<{ positionKey: string; reason: string }> = [];

  const phase = opts.phaseKey ?? (await currentPhase(opts.sessionId));

  // Resolve the CONFIGURED faculty for this context. This is what makes the
  // Faculty Builder authoritative: if a member has been configured, its
  // attention rules decide, not the hardcoded position policy.
  const effective = await effectivePolicies({
    courseId: opts.courseId ?? null,
    sessionKind: opts.sessionKind,
    slotId: opts.slotId ?? null,
    positions: opts.protocol.positions.map((p) => p.positionKey),
  });

  for (const p of opts.protocol.positions) {
    const position = getFacultyPosition(p.positionKey);
    if (!position) continue;
    const policy = getAttentionPolicy(p.positionKey);

    // --- configured member governs, when one exists -----------------------
    const eff = effective.get(p.positionKey);
    if (eff && eff.memberId) {
      const outcome = evaluateAttention(eff, {
        eventType: opts.eventType,
        phaseKey: phase ?? undefined,
        payload: opts.payload,
      });

      await recordAttentionDecision({
        sessionId: opts.sessionId,
        eventType: opts.eventType,
        outcome,
        provenance: eff.provenance,
      });

      if (outcome.action === "ignore") {
        ignoredBy.push({ positionKey: p.positionKey, reason: outcome.reason });
        continue;
      }

      const actionMap: Record<string, RoutedPosition["action"]> = {
        notice: "note",
        activate: "activate",
        consult: "consult",
        defer: "note",
        escalate: "consult",
        speak: "activate",
      };

      routed.push({
        positionKey: p.positionKey,
        name: eff.memberName || position.name,
        priority: outcome.priority,
        because: outcome.reason,
        action: actionMap[outcome.action] ?? "note",
        newState: outcome.state,
      });

      await setAttention({
        sessionId: opts.sessionId,
        positionKey: p.positionKey,
        state: outcome.state,
        reason: outcome.reason,
        phaseKey: phase ?? "",
      });
      continue;
    }

    // --- no configured member: institutional position policy applies -------
    const trigger = evaluateTrigger(p.positionKey, opts.eventType);

    if (!trigger) {
      ignoredBy.push({
        positionKey: p.positionKey,
        reason: `"${opts.eventType}" is not within ${position.name}'s attention scope.`,
      });
      continue;
    }

    // Administration stays out of teaching regardless of triggers, unless the
    // event is genuinely institutional.
    const institutionalEvent =
      opts.eventType === "record_worthy_event_detected" ||
      opts.eventType === "decision_accepted" ||
      opts.eventType === "session_nearing_completion";
    if (position.branch === "administration" && !institutionalEvent) {
      ignoredBy.push({
        positionKey: p.positionKey,
        reason: `${position.name} is administration and does not respond to teaching events.`,
      });
      continue;
    }

    // A conditional position only activates on its declared conditions.
    if (p.mode === "conditional" && !p.activatesOn.includes(opts.eventType)) {
      ignoredBy.push({
        positionKey: p.positionKey,
        reason: `${position.name} is conditional in this course and "${opts.eventType}" is not a declared activation condition.`,
      });
      continue;
    }

    // Phase relevance: a position out of phase observes but does not act.
    const phaseRelevant = !phase || !policy || policy.relevantPhases.includes(phase);

    let priority = trigger.priority;
    if (!phaseRelevant) priority = "low";

    let action: RoutedPosition["action"] = "note";
    let newState = "watching";

    if (priority === "low") {
      action = "note";
      newState = position.branch === "administration" ? "dormant" : "watching";
    } else if (priority === "normal") {
      action = phaseRelevant ? "activate" : "note";
      newState = phaseRelevant ? "engaged" : "watching";
    } else if (priority === "high") {
      // High priority means REQUEST, not seize.
      const interrupt = mayInterrupt(p.positionKey, priority, {
        materiallyAffectsLesson: true,
      });
      action = interrupt.allowed ? "activate" : "consult";
      newState = interrupt.allowed ? "engaged" : "escalated";
    } else {
      const interrupt = mayInterrupt(p.positionKey, priority, {
        materiallyAffectsLesson: true,
        institutionalIntegrity: position.branch === "administration",
      });
      action = interrupt.allowed ? "interrupt" : "consult";
      newState = interrupt.allowed ? "engaged" : "escalated";
    }

    routed.push({
      positionKey: p.positionKey,
      name: position.name,
      priority,
      because: phaseRelevant
        ? trigger.because
        : `${trigger.because} (Out of phase "${phase}" — downgraded to observation.)`,
      action,
      newState,
    });
  }

  const [event] = await db
    .insert(collegeSessionEventBus)
    .values({
      sessionId: opts.sessionId,
      sequence: Number(count) + 1,
      eventType: opts.eventType,
      payload: (opts.payload ?? "").slice(0, 8000),
      emittedBy: opts.emittedBy ?? "system",
      phaseKey: phase,
      routedTo: JSON.stringify(
        routed.map((r) => ({
          positionKey: r.positionKey,
          priority: r.priority,
          action: r.action,
          because: r.because,
        }))
      ),
    })
    .returning();

  // Apply the resulting attention transitions.
  for (const r of routed) {
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: r.positionKey,
      state: r.newState,
      reason: r.because,
      phaseKey: phase,
      triggeredByEventId: event.id,
    });
  }

  return {
    eventId: event.id,
    eventType: opts.eventType,
    routed,
    ignoredBy,
  };
}

// ---------------------------------------------------------------------------
// Consultations
// ---------------------------------------------------------------------------

export async function requestConsultation(input: {
  sessionId: string;
  requestingPosition: string;
  requestedPosition: string;
  reason: string;
  question: string;
  evidenceRefs?: string[];
  urgency?: AttentionPriority;
  scope?: string;
  responseRequired?: boolean;
}): Promise<
  { ok: true; consultation: typeof collegeConsultations.$inferSelect } | { ok: false; error: string }
> {
  const permitted = policyMayConsult(input.requestingPosition, input.requestedPosition);
  if (!permitted.allowed) return { ok: false, error: permitted.reason };

  const requested = getFacultyPosition(input.requestedPosition);
  if (requested && requested.branch === "administration") {
    // Consulting Administration is allowed, but it is a branch crossing and
    // must be recorded as such rather than treated as ordinary teaching chat.
    await db.insert(collegeSessionEvents).values({
      sessionId: input.sessionId,
      stage: "institutional_update",
      note: `${input.requestingPosition} consulted Administration (${input.requestedPosition}). Branch boundary crossed deliberately.`,
      actor: `faculty:${input.requestingPosition}`,
    });
  }

  const [row] = await db
    .insert(collegeConsultations)
    .values({
      sessionId: input.sessionId,
      requestingPosition: input.requestingPosition,
      requestedPosition: input.requestedPosition,
      reason: input.reason.slice(0, 2000),
      question: input.question.slice(0, 2000),
      evidenceRefs: JSON.stringify(input.evidenceRefs ?? []),
      urgency: input.urgency ?? "normal",
      scope: (input.scope ?? "").slice(0, 1000),
      responseRequired: input.responseRequired ?? true,
    })
    .returning();

  await setAttention({
    sessionId: input.sessionId,
    positionKey: input.requestingPosition,
    state: "waiting",
    reason: `Awaiting ${input.requestedPosition}: ${input.question.slice(0, 160)}`,
  });
  await setAttention({
    sessionId: input.sessionId,
    positionKey: input.requestedPosition,
    state: "consulting",
    reason: `Consulted by ${input.requestingPosition}: ${input.reason.slice(0, 160)}`,
  });

  return { ok: true, consultation: row };
}

export async function answerConsultation(input: {
  id: string;
  response: string;
  outcome?: string;
  contributionId?: string | null;
  status?: "answered" | "declined" | "out_of_remit";
}) {
  const [row] = await db
    .update(collegeConsultations)
    .set({
      response: input.response.slice(0, 8000),
      outcome: (input.outcome ?? "").slice(0, 2000),
      contributionId: input.contributionId ?? null,
      status: input.status ?? "answered",
      respondedAt: new Date(),
    })
    .where(eq(collegeConsultations.id, input.id))
    .returning();
  if (!row) return null;

  await setAttention({
    sessionId: row.sessionId,
    positionKey: row.requestingPosition,
    state: "engaged",
    reason: `${row.requestedPosition} responded. Resuming.`,
  });
  return row;
}

export async function openConsultations(sessionId: string) {
  return db
    .select()
    .from(collegeConsultations)
    .where(and(eq(collegeConsultations.sessionId, sessionId), eq(collegeConsultations.status, "open")))
    .orderBy(asc(collegeConsultations.createdAt));
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

export async function handOff(input: {
  sessionId: string;
  fromPosition: string;
  toPosition: string;
  reason: string;
  payload?: string;
}): Promise<
  { ok: true; handoff: typeof collegeHandoffs.$inferSelect } | { ok: false; error: string }
> {
  const permitted = policyMayHandOff(input.fromPosition, input.toPosition);
  if (!permitted.allowed) return { ok: false, error: permitted.reason };

  const from = getFacultyPosition(input.fromPosition);
  const to = getFacultyPosition(input.toPosition);
  const crossesBranch = Boolean(from && to && from.branch !== to.branch);

  const [row] = await db
    .insert(collegeHandoffs)
    .values({
      sessionId: input.sessionId,
      fromPosition: input.fromPosition,
      toPosition: input.toPosition,
      reason: input.reason.slice(0, 2000),
      payload: (input.payload ?? "").slice(0, 8000),
      crossesBranch,
      disposition: "pending",
    })
    .returning();

  await setAttention({
    sessionId: input.sessionId,
    positionKey: input.fromPosition,
    state: "handing_off",
    reason: `Handing responsibility to ${to?.name ?? input.toPosition}: ${input.reason.slice(0, 160)}`,
  });

  if (crossesBranch) {
    await db.insert(collegeSessionEvents).values({
      sessionId: input.sessionId,
      stage: "faculty_record",
      note: `Branch boundary crossed: ${from?.name} (${from?.branch}) → ${to?.name} (${to?.branch}). ${input.reason}`,
      actor: `faculty:${input.fromPosition}`,
    });
  }

  return { ok: true, handoff: row };
}

export async function settleHandoff(input: {
  id: string;
  disposition: "accepted" | "deferred" | "refused";
  dispositionReason: string;
}) {
  const [row] = await db
    .update(collegeHandoffs)
    .set({
      disposition: input.disposition,
      dispositionReason: input.dispositionReason.slice(0, 2000),
    })
    .where(eq(collegeHandoffs.id, input.id))
    .returning();
  if (!row) return null;

  await setAttention({
    sessionId: row.sessionId,
    positionKey: row.toPosition,
    state: input.disposition === "accepted" ? "engaged" : "deferred",
    reason: input.dispositionReason,
  });
  await setAttention({
    sessionId: row.sessionId,
    positionKey: row.fromPosition,
    state: "completed",
    reason: `Handoff ${input.disposition}.`,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Interruptions
// ---------------------------------------------------------------------------

/**
 * Attempt an interruption. Refusals are RECORDED, not silently dropped —
 * a position trying to exceed its authority is institutional evidence.
 */
export async function attemptInterruption(input: {
  sessionId: string;
  positionKey: string;
  interruptedPosition?: string;
  reason: string;
  urgency?: AttentionPriority;
  materiallyAffectsLesson?: boolean;
  institutionalIntegrity?: boolean;
}) {
  const urgency = input.urgency ?? "normal";
  const verdict = mayInterrupt(input.positionKey, urgency, {
    materiallyAffectsLesson: input.materiallyAffectsLesson,
    institutionalIntegrity: input.institutionalIntegrity,
  });

  const [row] = await db
    .insert(collegeInterruptions)
    .values({
      sessionId: input.sessionId,
      positionKey: input.positionKey,
      interruptedPosition: input.interruptedPosition ?? "",
      reason: input.reason.slice(0, 2000),
      urgency,
      outcome: verdict.allowed ? "granted" : "refused",
      outcomeReason: verdict.reason,
    })
    .returning();

  if (!verdict.allowed) {
    await setAttention({
      sessionId: input.sessionId,
      positionKey: input.positionKey,
      state: "escalated",
      reason: `Interruption refused: ${verdict.reason} Raising through consultation instead.`,
    });
  }

  return { allowed: verdict.allowed, reason: verdict.reason, interruption: row };
}

// ---------------------------------------------------------------------------
// Coordination trace
// ---------------------------------------------------------------------------

export interface TraceEntry {
  at: string;
  kind: "phase" | "event" | "attention" | "consultation" | "handoff" | "interruption";
  actor: string;
  summary: string;
  detail: string;
}

/**
 * The inspectable record of how the faculty coordinated.
 * Structured actions, reasons and outcomes — never internal chain-of-thought.
 */
export async function coordinationTrace(sessionId: string): Promise<TraceEntry[]> {
  const [phases, events, attention, consults, handoffs, interruptions] = await Promise.all([
    db.select().from(collegeSessionPhases).where(eq(collegeSessionPhases.sessionId, sessionId)),
    db.select().from(collegeSessionEventBus).where(eq(collegeSessionEventBus.sessionId, sessionId)),
    db.select().from(collegeFacultyAttention).where(eq(collegeFacultyAttention.sessionId, sessionId)),
    db.select().from(collegeConsultations).where(eq(collegeConsultations.sessionId, sessionId)),
    db.select().from(collegeHandoffs).where(eq(collegeHandoffs.sessionId, sessionId)),
    db.select().from(collegeInterruptions).where(eq(collegeInterruptions.sessionId, sessionId)),
  ]);

  const name = (k: string) => getFacultyPosition(k)?.name ?? k;
  const entries: TraceEntry[] = [];

  for (const p of phases) {
    entries.push({
      at: (p.enteredAt ?? new Date()).toISOString(),
      kind: "phase",
      actor: "system",
      summary: `PHASE → ${p.phaseKey}`,
      detail: `primary: ${JSON.parse(p.primaryPositions || "[]").join(", ") || "none"} · watching: ${
        JSON.parse(p.watchingPositions || "[]").join(", ") || "none"
      }`,
    });
  }
  for (const e of events) {
    const routed = JSON.parse(e.routedTo || "[]") as Array<{
      positionKey: string;
      priority: string;
      action: string;
    }>;
    entries.push({
      at: (e.createdAt ?? new Date()).toISOString(),
      kind: "event",
      actor: e.emittedBy,
      summary: `EVENT ${e.eventType}`,
      detail: routed.length
        ? `routed → ${routed.map((r) => `${name(r.positionKey)} (${r.priority}/${r.action})`).join(", ")}`
        : "no position's remit — no faculty activated",
    });
  }
  for (const a of attention) {
    entries.push({
      at: (a.createdAt ?? new Date()).toISOString(),
      kind: "attention",
      actor: name(a.positionKey),
      summary: `${a.previousState ? `${a.previousState} → ` : ""}${a.state.toUpperCase()}${
        a.spoke ? " (spoke)" : " (silent)"
      }`,
      detail: a.reason,
    });
  }
  for (const c of consults) {
    entries.push({
      at: (c.createdAt ?? new Date()).toISOString(),
      kind: "consultation",
      actor: name(c.requestingPosition),
      summary: `CONSULT → ${name(c.requestedPosition)} [${c.status}]`,
      detail: `${c.question}${c.outcome ? ` · outcome: ${c.outcome}` : ""}`,
    });
  }
  for (const h of handoffs) {
    entries.push({
      at: (h.createdAt ?? new Date()).toISOString(),
      kind: "handoff",
      actor: name(h.fromPosition),
      summary: `HANDOFF → ${name(h.toPosition)} [${h.disposition}]${
        h.crossesBranch ? " ⚠ crosses branch" : ""
      }`,
      detail: h.reason,
    });
  }
  for (const i of interruptions) {
    entries.push({
      at: (i.createdAt ?? new Date()).toISOString(),
      kind: "interruption",
      actor: name(i.positionKey),
      summary: `INTERRUPT ${i.outcome.toUpperCase()}`,
      detail: `${i.reason} — ${i.outcomeReason}`,
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** Positions currently permitted to produce student-visible output. */
export async function speakingPositions(sessionId: string): Promise<string[]> {
  const attention = await currentAttention(sessionId);
  return attention.filter((a) => stateSpeaks(a.state)).map((a) => a.positionKey);
}

export { maxPriority };
