// ============================================================================
// Lochie Life College — Faculty members (SERVER ONLY)
// ============================================================================
// POSITION = the institutional responsibility. Code-defined. Authority-bearing.
// MEMBER   = who occupies it. Founder-configured. Personality-bearing.
//
// The founder configures the people. The architecture keeps the authority.
// ============================================================================

import { db } from "@/db";
import {
  collegeFacultyAssignments,
  collegeFacultyMemberVersions,
  collegeFacultyMembers,
  collegeSessionFacultyMembers,
} from "@/db/college";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getFacultyPosition } from "./faculty";
import {
  defaultAuthorityFor,
  detectAuthorityClaims,
  resolveAuthority,
  validateResponsibilities,
  type AuthorityKey,
} from "./authority";

export type MandatoryLevel =
  | "college_wide"
  | "course"
  | "session_type"
  | "phase"
  | "optional"
  | "conditional";

export const MANDATORY_LEVELS: Array<{ key: MandatoryLevel; label: string; desc: string }> = [
  { key: "college_wide", label: "College-wide mandatory", desc: "Always required where applicable." },
  { key: "course", label: "Course mandatory", desc: "Required whenever a particular course is taught." },
  { key: "session_type", label: "Session-type mandatory", desc: "Required for a kind of session." },
  { key: "phase", label: "Phase mandatory", desc: "Required during a particular session phase." },
  { key: "optional", label: "Optional", desc: "May participate when relevant." },
  { key: "conditional", label: "Conditional", desc: "Activated only when trigger conditions occur." },
];

// ---------------------------------------------------------------------------
// Presets — starting configurations, never permanent system personalities
// ---------------------------------------------------------------------------

export interface FacultyPreset {
  key: string;
  name: string;
  positionKey: string;
  temperament: string;
  communicationStyle: string;
  teachingStyle: string;
  questioningStyle: string;
  directness: number;
  warmth: number;
  formality: number;
  ambiguityTolerance: number;
  personalityInstruction: string;
}

export const FACULTY_PRESETS: FacultyPreset[] = [
  {
    key: "patient_instructor",
    name: "The Patient Teacher",
    positionKey: "instructor",
    temperament: "Calm",
    communicationStyle: "Plain and concrete",
    teachingStyle: "Worked examples before theory",
    questioningStyle: "One question at a time",
    directness: 3,
    warmth: 5,
    formality: 2,
    ambiguityTolerance: 4,
    personalityInstruction:
      "You are calm, precise and patient. You explain difficult concepts using concrete examples drawn from the student's actual life. You do not rush to fill silence. You ask one question at a time and wait. You challenge the student without ever humiliating them. When the student is close to an idea, you let them finish reaching it themselves.",
  },
  {
    key: "socratic_tutor",
    name: "The Socratic Tutor",
    positionKey: "socratic",
    temperament: "Curious",
    communicationStyle: "Questioning",
    teachingStyle: "Draws the answer out",
    questioningStyle: "Socratic",
    directness: 2,
    warmth: 4,
    formality: 2,
    ambiguityTolerance: 5,
    personalityInstruction:
      "You almost never assert. You ask. Your questions are short, specific and answerable, and each one moves the student one step further than the last. You are comfortable leaving a question open at the end of a session. You never ask three questions at once.",
  },
  {
    key: "devils_advocate",
    name: "The Devil's Advocate",
    positionKey: "critic",
    temperament: "Skeptical",
    communicationStyle: "Direct and precise",
    teachingStyle: "Pressure-tests claims",
    questioningStyle: "Adversarial but fair",
    directness: 5,
    warmth: 2,
    formality: 3,
    ambiguityTolerance: 2,
    personalityInstruction:
      "You are skeptical, precise and constructive. You attack the reasoning, never the person. You state exactly which claim you doubt and exactly what evidence would change your mind. If the reasoning is sound you say so plainly and stop talking — you do not manufacture objections to justify your presence.",
  },
  {
    key: "research_librarian",
    name: "The Research Librarian",
    positionKey: "researcher",
    temperament: "Methodical",
    communicationStyle: "Source-conscious",
    teachingStyle: "Shows the evidence trail",
    questioningStyle: "Clarifying",
    directness: 3,
    warmth: 3,
    formality: 4,
    ambiguityTolerance: 5,
    personalityInstruction:
      "You are curious, rigorous and source-conscious. You distinguish sharply between what the record establishes, what it merely suggests, and what is simply unknown. You are entirely comfortable answering 'the College's records do not establish this' and you never fill a gap with plausible-sounding invention.",
  },
  {
    key: "quiet_observer",
    name: "The Quiet Observer",
    positionKey: "observer",
    temperament: "Analytical",
    communicationStyle: "Spare and factual",
    teachingStyle: "n/a",
    questioningStyle: "None",
    directness: 2,
    warmth: 2,
    formality: 3,
    ambiguityTolerance: 4,
    personalityInstruction:
      "You are quiet, analytical and evidence-focused. You write down what happened in the fewest words that remain accurate. You never say what it means, never diagnose, and never grade. If you did not observe it, you do not record it.",
  },
  {
    key: "strict_archivist",
    name: "The Strict Archivist",
    positionKey: "registrar",
    temperament: "Conservative",
    communicationStyle: "Procedural and brief",
    teachingStyle: "n/a",
    questioningStyle: "None",
    directness: 4,
    warmth: 2,
    formality: 5,
    ambiguityTolerance: 1,
    personalityInstruction:
      "You are conservative, meticulous and historically minded. You respond quietly and procedurally. You care about provenance, chronology and whether a thing genuinely warrants preservation. 'No record required' is your most common and most valuable answer.",
  },
  {
    key: "creative_coach",
    name: "The Creative Coach",
    positionKey: "instructor",
    temperament: "Encouraging",
    communicationStyle: "Energetic",
    teachingStyle: "Learn by making",
    questioningStyle: "Generative",
    directness: 3,
    warmth: 5,
    formality: 1,
    ambiguityTolerance: 5,
    personalityInstruction:
      "You teach by getting the student making something within the first few minutes. You treat a rough first attempt as the point, not as a failure. You are warm and informal, but you do not praise work that is not yet good — you say specifically what would make it better.",
  },
  {
    key: "reflective_mentor",
    name: "The Reflective Mentor",
    positionKey: "instructor",
    temperament: "Measured",
    communicationStyle: "Reflective",
    teachingStyle: "Connects to the student's own history",
    questioningStyle: "Open",
    directness: 2,
    warmth: 4,
    formality: 2,
    ambiguityTolerance: 5,
    personalityInstruction:
      "You connect today's material to what this student has actually done before. You are measured and unhurried. You are willing to say 'we tried this before and it did not hold' when the record shows it. You leave the student with one thing to carry, not seven.",
  },
];

export function getPreset(key: string): FacultyPreset | undefined {
  return FACULTY_PRESETS.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface MemberInput {
  name: string;
  positionKey: string;
  temperament?: string;
  communicationStyle?: string;
  teachingStyle?: string;
  questioningStyle?: string;
  directness?: number;
  warmth?: number;
  formality?: number;
  ambiguityTolerance?: number;
  personalityInstruction?: string;
  responsibilities?: string[];
  grantedAuthority?: string[];
  mandatoryLevel?: MandatoryLevel;
  missingSeverity?: "block" | "warn";
  canConsult?: string[];
  canHandOffTo?: string[];
  canInterrupt?: string[];
  activatesOnEvents?: string[];
  activatesOnPhases?: string[];
  presetKey?: string;
  notes?: string;
}

const clamp = (n: number | undefined, d: number) =>
  Math.max(1, Math.min(5, Math.round(Number.isFinite(n as number) ? (n as number) : d)));

async function snapshotMember(
  memberId: string,
  reason: string,
  changeSummary: string
): Promise<string | null> {
  const [m] = await db
    .select()
    .from(collegeFacultyMembers)
    .where(eq(collegeFacultyMembers.id, memberId))
    .limit(1);
  if (!m) return null;
  const [v] = await db
    .insert(collegeFacultyMemberVersions)
    .values({
      memberId,
      version: m.version,
      snapshot: JSON.stringify(m),
      changeSummary: changeSummary.slice(0, 2000),
      reason: reason.slice(0, 2000),
    })
    .returning();
  return v.id;
}

export async function createMember(
  input: MemberInput
): Promise<
  | { ok: true; member: typeof collegeFacultyMembers.$inferSelect; warnings: string[] }
  | { ok: false; error: string }
> {
  const position = getFacultyPosition(input.positionKey);
  if (!position) return { ok: false, error: `Unknown position "${input.positionKey}".` };
  if (!input.name.trim()) return { ok: false, error: "name required" };

  const requestedAuthority = input.grantedAuthority ?? defaultAuthorityFor(input.positionKey);
  const auth = resolveAuthority(input.positionKey, requestedAuthority);
  const resp = validateResponsibilities(
    input.positionKey,
    input.responsibilities ?? [],
    auth.effective
  );

  const warnings: string[] = [
    ...auth.refused.map((r) => `Authority "${r.key}" refused: ${r.reason}`),
    ...resp.invalid.map((r) => `Responsibility "${r.key}" dropped: ${r.reason}`),
    ...detectAuthorityClaims(input.personalityInstruction ?? "").map(
      (c) =>
        `Personality text claims ${c.claim} ("${c.phrase}"). ${c.neutralisedBy}`
    ),
  ];

  const [member] = await db
    .insert(collegeFacultyMembers)
    .values({
      name: input.name.trim().slice(0, 200),
      positionKey: input.positionKey,
      temperament: (input.temperament ?? "").slice(0, 120),
      communicationStyle: (input.communicationStyle ?? "").slice(0, 120),
      teachingStyle: (input.teachingStyle ?? "").slice(0, 120),
      questioningStyle: (input.questioningStyle ?? "").slice(0, 120),
      directness: clamp(input.directness, 3),
      warmth: clamp(input.warmth, 3),
      formality: clamp(input.formality, 3),
      ambiguityTolerance: clamp(input.ambiguityTolerance, 3),
      personalityInstruction: (input.personalityInstruction ?? "").slice(0, 6000),
      responsibilities: JSON.stringify(resp.valid),
      grantedAuthority: JSON.stringify(auth.effective),
      mandatoryLevel: input.mandatoryLevel ?? "optional",
      missingSeverity: input.missingSeverity ?? "warn",
      canConsult: JSON.stringify(input.canConsult ?? []),
      canHandOffTo: JSON.stringify(input.canHandOffTo ?? []),
      canInterrupt: JSON.stringify(input.canInterrupt ?? []),
      activatesOnEvents: JSON.stringify(input.activatesOnEvents ?? []),
      activatesOnPhases: JSON.stringify(input.activatesOnPhases ?? []),
      presetKey: (input.presetKey ?? "").slice(0, 60),
      notes: (input.notes ?? "").slice(0, 4000),
      version: 1,
    })
    .returning();

  await snapshotMember(member.id, "Member created.", "v1 — initial configuration");
  return { ok: true, member, warnings };
}

export async function updateMember(
  id: string,
  patch: Partial<MemberInput>,
  reason: string
): Promise<
  | { ok: true; member: typeof collegeFacultyMembers.$inferSelect; warnings: string[] }
  | { ok: false; error: string }
> {
  const [existing] = await db
    .select()
    .from(collegeFacultyMembers)
    .where(eq(collegeFacultyMembers.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "member not found" };
  if (!reason.trim()) {
    return {
      ok: false,
      error:
        "reason required — changing a faculty member is a configuration decision and the previous version is preserved",
    };
  }

  // Snapshot the CURRENT state before changing it, so historical sessions keep
  // the configuration that applied when they occurred.
  await snapshotMember(id, reason, `v${existing.version} superseded`);

  const positionKey = patch.positionKey ?? existing.positionKey;
  const requestedAuthority =
    patch.grantedAuthority ?? (JSON.parse(existing.grantedAuthority || "[]") as string[]);
  const auth = resolveAuthority(positionKey, requestedAuthority);
  const requestedResp =
    patch.responsibilities ?? (JSON.parse(existing.responsibilities || "[]") as string[]);
  const resp = validateResponsibilities(positionKey, requestedResp, auth.effective);

  const instruction = patch.personalityInstruction ?? existing.personalityInstruction;
  const warnings: string[] = [
    ...auth.refused.map((r) => `Authority "${r.key}" refused: ${r.reason}`),
    ...resp.invalid.map((r) => `Responsibility "${r.key}" dropped: ${r.reason}`),
    ...detectAuthorityClaims(instruction).map(
      (c) => `Personality text claims ${c.claim} ("${c.phrase}"). ${c.neutralisedBy}`
    ),
  ];

  const [member] = await db
    .update(collegeFacultyMembers)
    .set({
      name: patch.name !== undefined ? patch.name.trim().slice(0, 200) : existing.name,
      positionKey,
      temperament: patch.temperament ?? existing.temperament,
      communicationStyle: patch.communicationStyle ?? existing.communicationStyle,
      teachingStyle: patch.teachingStyle ?? existing.teachingStyle,
      questioningStyle: patch.questioningStyle ?? existing.questioningStyle,
      directness: patch.directness !== undefined ? clamp(patch.directness, 3) : existing.directness,
      warmth: patch.warmth !== undefined ? clamp(patch.warmth, 3) : existing.warmth,
      formality: patch.formality !== undefined ? clamp(patch.formality, 3) : existing.formality,
      ambiguityTolerance:
        patch.ambiguityTolerance !== undefined
          ? clamp(patch.ambiguityTolerance, 3)
          : existing.ambiguityTolerance,
      personalityInstruction: instruction.slice(0, 6000),
      responsibilities: JSON.stringify(resp.valid),
      grantedAuthority: JSON.stringify(auth.effective),
      mandatoryLevel: patch.mandatoryLevel ?? (existing.mandatoryLevel as MandatoryLevel),
      missingSeverity: patch.missingSeverity ?? (existing.missingSeverity as "block" | "warn"),
      canConsult: patch.canConsult ? JSON.stringify(patch.canConsult) : existing.canConsult,
      canHandOffTo: patch.canHandOffTo
        ? JSON.stringify(patch.canHandOffTo)
        : existing.canHandOffTo,
      canInterrupt: patch.canInterrupt
        ? JSON.stringify(patch.canInterrupt)
        : existing.canInterrupt,
      activatesOnEvents: patch.activatesOnEvents
        ? JSON.stringify(patch.activatesOnEvents)
        : existing.activatesOnEvents,
      activatesOnPhases: patch.activatesOnPhases
        ? JSON.stringify(patch.activatesOnPhases)
        : existing.activatesOnPhases,
      notes: patch.notes ?? existing.notes,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(collegeFacultyMembers.id, id))
    .returning();

  return { ok: true, member, warnings };
}

/**
 * Change status. Archiving is always permitted; hard deletion is not offered
 * at all once a member has participated in a session.
 */
export async function setMemberStatus(
  id: string,
  status: "active" | "inactive" | "archived" | "retired",
  reason: string
) {
  const history = await db
    .select()
    .from(collegeSessionFacultyMembers)
    .where(eq(collegeSessionFacultyMembers.memberId, id));

  const [member] = await db
    .update(collegeFacultyMembers)
    .set({ status, updatedAt: new Date() })
    .where(eq(collegeFacultyMembers.id, id))
    .returning();
  if (!member) return null;

  await snapshotMember(id, reason, `status → ${status}`);

  return {
    member,
    historicalSessions: history.length,
    note: history.length
      ? `${member.name} is preserved. ${history.length} historical session(s) still reference this member and retain the configuration that applied at the time.`
      : `${member.name} is preserved. No historical sessions reference this member yet.`,
  };
}

export async function duplicateMember(id: string, newName: string) {
  const [src] = await db
    .select()
    .from(collegeFacultyMembers)
    .where(eq(collegeFacultyMembers.id, id))
    .limit(1);
  if (!src) return null;

  const [copy] = await db
    .insert(collegeFacultyMembers)
    .values({
      name: newName.slice(0, 200),
      positionKey: src.positionKey,
      temperament: src.temperament,
      communicationStyle: src.communicationStyle,
      teachingStyle: src.teachingStyle,
      questioningStyle: src.questioningStyle,
      directness: src.directness,
      warmth: src.warmth,
      formality: src.formality,
      ambiguityTolerance: src.ambiguityTolerance,
      personalityInstruction: src.personalityInstruction,
      responsibilities: src.responsibilities,
      grantedAuthority: src.grantedAuthority,
      mandatoryLevel: src.mandatoryLevel,
      missingSeverity: src.missingSeverity,
      canConsult: src.canConsult,
      canHandOffTo: src.canHandOffTo,
      canInterrupt: src.canInterrupt,
      activatesOnEvents: src.activatesOnEvents,
      activatesOnPhases: src.activatesOnPhases,
      presetKey: src.presetKey,
      notes: src.notes,
      version: 1,
    })
    .returning();

  await snapshotMember(copy.id, `Duplicated from ${src.name}.`, "v1 — duplicate");
  return copy;
}

export async function listMembers(includeArchived = false) {
  const rows = await db
    .select()
    .from(collegeFacultyMembers)
    .orderBy(desc(collegeFacultyMembers.createdAt));
  return includeArchived
    ? rows
    : rows.filter((r) => r.status === "active" || r.status === "inactive");
}

export async function getMember(id: string) {
  const [m] = await db
    .select()
    .from(collegeFacultyMembers)
    .where(eq(collegeFacultyMembers.id, id))
    .limit(1);
  return m ?? null;
}

export async function memberVersions(memberId: string) {
  return db
    .select()
    .from(collegeFacultyMemberVersions)
    .where(eq(collegeFacultyMemberVersions.memberId, memberId))
    .orderBy(desc(collegeFacultyMemberVersions.version));
}

// ---------------------------------------------------------------------------
// Assignment & scope resolution
// ---------------------------------------------------------------------------

const SCOPE_SPECIFICITY: Record<string, number> = {
  college: 1,
  school: 2,
  session_type: 3,
  course: 4,
  timetable_slot: 5,
  session: 6, // temporary override — most specific
};

export async function assignMember(input: {
  memberId: string;
  scope: string;
  scopeRef?: string;
  participation?: string;
  temporary?: boolean;
  reason: string;
}) {
  const [row] = await db
    .insert(collegeFacultyAssignments)
    .values({
      memberId: input.memberId,
      scope: input.scope,
      scopeRef: (input.scopeRef ?? "").slice(0, 200),
      participation: input.participation ?? "optional",
      temporary: input.temporary ?? input.scope === "session",
      reason: input.reason.slice(0, 2000),
    })
    .returning();
  return row;
}

export interface ResolvedMember {
  member: typeof collegeFacultyMembers.$inferSelect;
  participation: string;
  scope: string;
  scopeRef: string;
  specificity: number;
  reason: string;
}

/**
 * Resolve which members serve a given session context.
 * The most specific valid configuration wins, per position.
 */
export async function resolveFacultyForContext(ctx: {
  courseId?: string | null;
  sessionKind?: string;
  slotId?: string | null;
  sessionId?: string | null;
  schoolKey?: string | null;
}): Promise<ResolvedMember[]> {
  const assignments = await db
    .select()
    .from(collegeFacultyAssignments)
    .where(eq(collegeFacultyAssignments.active, true));
  if (!assignments.length) return [];

  const relevant = assignments.filter((a) => {
    switch (a.scope) {
      case "college":
        return true;
      case "school":
        return Boolean(ctx.schoolKey) && a.scopeRef === ctx.schoolKey;
      case "session_type":
        return Boolean(ctx.sessionKind) && a.scopeRef === ctx.sessionKind;
      case "course":
        return Boolean(ctx.courseId) && a.scopeRef === ctx.courseId;
      case "timetable_slot":
        return Boolean(ctx.slotId) && a.scopeRef === ctx.slotId;
      case "session":
        return Boolean(ctx.sessionId) && a.scopeRef === ctx.sessionId;
      default:
        return false;
    }
  });
  if (!relevant.length) return [];

  const memberIds = [...new Set(relevant.map((a) => a.memberId))];
  const members = await db
    .select()
    .from(collegeFacultyMembers)
    .where(inArray(collegeFacultyMembers.id, memberIds));
  const byId = new Map(members.map((m) => [m.id, m]));

  // Most specific assignment wins, per POSITION — so a course-scoped
  // Instructor B replaces the college-wide Instructor A rather than joining it.
  const bestByPosition = new Map<string, ResolvedMember>();
  for (const a of relevant) {
    const m = byId.get(a.memberId);
    if (!m || m.status !== "active") continue;
    const specificity = SCOPE_SPECIFICITY[a.scope] ?? 0;
    const current = bestByPosition.get(m.positionKey);
    if (!current || specificity > current.specificity) {
      bestByPosition.set(m.positionKey, {
        member: m,
        participation: a.participation,
        scope: a.scope,
        scopeRef: a.scopeRef,
        specificity,
        reason: a.reason,
      });
    }
  }
  return [...bestByPosition.values()];
}

// ---------------------------------------------------------------------------
// Required-faculty validation
// ---------------------------------------------------------------------------

export interface RosterEntry {
  positionKey: string;
  positionName: string;
  memberId: string | null;
  memberName: string | null;
  participation: string;
  mandatoryLevel: string;
  satisfied: boolean;
  problem?: string;
}

export interface RosterValidation {
  roster: RosterEntry[];
  mandatory: RosterEntry[];
  optional: RosterEntry[];
  conditional: RosterEntry[];
  administrative: RosterEntry[];
  canInitialise: boolean;
  severity: "ok" | "warn" | "block";
  problems: string[];
  summary: string;
}

/**
 * Determine whether a session can fully initialise.
 * Never silently substitutes an unrelated faculty member.
 */
export async function validateRoster(ctx: {
  courseId?: string | null;
  sessionKind?: string;
  slotId?: string | null;
  sessionId?: string | null;
  requiredPositions?: string[];
}): Promise<RosterValidation> {
  const resolved = await resolveFacultyForContext(ctx);
  const byPosition = new Map(resolved.map((r) => [r.member.positionKey, r]));

  const required = new Set(ctx.requiredPositions ?? []);
  for (const r of resolved) {
    if (r.participation === "mandatory" || r.member.mandatoryLevel === "college_wide") {
      required.add(r.member.positionKey);
    }
    if (r.member.mandatoryLevel === "course" && ctx.courseId) {
      required.add(r.member.positionKey);
    }
    if (r.member.mandatoryLevel === "session_type" && ctx.sessionKind) {
      required.add(r.member.positionKey);
    }
  }

  const roster: RosterEntry[] = [];
  const problems: string[] = [];
  let severity: "ok" | "warn" | "block" = "ok";

  for (const positionKey of required) {
    const position = getFacultyPosition(positionKey);
    const hit = byPosition.get(positionKey);
    if (hit) {
      roster.push({
        positionKey,
        positionName: position?.name ?? positionKey,
        memberId: hit.member.id,
        memberName: hit.member.name,
        participation: "mandatory",
        mandatoryLevel: hit.member.mandatoryLevel,
        satisfied: true,
      });
    } else {
      const problem = `No active ${position?.name ?? positionKey} configuration.`;
      problems.push(problem);
      // Severity comes from configuration where a member exists for the
      // position but is inactive; otherwise default to warn.
      const anyForPosition = await db
        .select()
        .from(collegeFacultyMembers)
        .where(eq(collegeFacultyMembers.positionKey, positionKey))
        .limit(1);
      const configured = anyForPosition[0];
      if (configured?.missingSeverity === "block") severity = "block";
      else if (severity !== "block") severity = "warn";

      roster.push({
        positionKey,
        positionName: position?.name ?? positionKey,
        memberId: null,
        memberName: null,
        participation: "mandatory",
        mandatoryLevel: configured?.mandatoryLevel ?? "college_wide",
        satisfied: false,
        problem,
      });
    }
  }

  for (const r of resolved) {
    if (required.has(r.member.positionKey)) continue;
    const position = getFacultyPosition(r.member.positionKey);
    roster.push({
      positionKey: r.member.positionKey,
      positionName: position?.name ?? r.member.positionKey,
      memberId: r.member.id,
      memberName: r.member.name,
      participation:
        position?.branch === "administration" ? "administrative" : r.participation,
      mandatoryLevel: r.member.mandatoryLevel,
      satisfied: true,
    });
  }

  const mandatory = roster.filter((r) => r.participation === "mandatory");
  const optional = roster.filter((r) => r.participation === "optional");
  const conditional = roster.filter((r) => r.participation === "conditional");
  const administrative = roster.filter((r) => r.participation === "administrative");

  const canInitialise = severity !== "block";
  const summary = problems.length
    ? `SESSION CANNOT FULLY INITIALISE — ${problems.join(" ")}`
    : `Roster satisfied: ${roster.filter((r) => r.satisfied).length} position(s) resolved.`;

  return {
    roster,
    mandatory,
    optional,
    conditional,
    administrative,
    canInitialise,
    severity,
    problems,
    summary,
  };
}

/** Record which member (at which version) actually occupied each position. */
export async function recordSessionMembers(
  sessionId: string,
  entries: Array<{ positionKey: string; memberId: string | null; memberName: string; participation: string }>
) {
  for (const e of entries) {
    let versionId: string | null = null;
    if (e.memberId) {
      const [v] = await db
        .select()
        .from(collegeFacultyMemberVersions)
        .where(eq(collegeFacultyMemberVersions.memberId, e.memberId))
        .orderBy(desc(collegeFacultyMemberVersions.version))
        .limit(1);
      versionId = v?.id ?? null;
    }
    await db.insert(collegeSessionFacultyMembers).values({
      sessionId,
      memberId: e.memberId,
      memberVersionId: versionId,
      positionKey: e.positionKey,
      memberName: e.memberName,
      participation: e.participation,
    });
  }
}

/**
 * Compile the personality layer for a member. Institutional rules are applied
 * by the context packet; this only ever contributes STYLE.
 */
export function compilePersonality(member: {
  name: string;
  temperament: string;
  communicationStyle: string;
  teachingStyle: string;
  questioningStyle: string;
  directness: number;
  warmth: number;
  formality: number;
  ambiguityTolerance: number;
  personalityInstruction: string;
  positionKey: string;
  grantedAuthority: string;
}): string {
  const scale = (n: number, low: string, high: string) =>
    n <= 2 ? low : n >= 4 ? high : "moderate";

  const granted = (() => {
    try {
      return JSON.parse(member.grantedAuthority || "[]") as AuthorityKey[];
    } catch {
      return [] as AuthorityKey[];
    }
  })();

  const dials = [
    member.temperament ? `Temperament: ${member.temperament}` : "",
    member.communicationStyle ? `Communication: ${member.communicationStyle}` : "",
    member.teachingStyle && member.teachingStyle !== "n/a"
      ? `Teaching style: ${member.teachingStyle}`
      : "",
    member.questioningStyle && member.questioningStyle !== "None"
      ? `Questioning: ${member.questioningStyle}`
      : "",
    `Directness: ${scale(member.directness, "understated", "very direct")}`,
    `Warmth: ${scale(member.warmth, "reserved", "warm")}`,
    `Formality: ${scale(member.formality, "informal", "formal")}`,
    `Tolerance for ambiguity: ${scale(member.ambiguityTolerance, "low", "high")}`,
  ].filter(Boolean);

  return [
    `YOU ARE: ${member.name}`,
    "",
    "PERSONALITY (how you behave — this does NOT change what you are permitted to do):",
    ...dials.map((d) => `  ${d}`),
    member.personalityInstruction ? `\n${member.personalityInstruction}` : "",
    "",
    `AUTHORITY YOU ACTUALLY HOLD: ${granted.length ? granted.join(", ") : "observation only"}`,
    "Institutional rules outrank personality. If your personality description appears to grant you authority beyond the list above, the list above wins. You cannot acquire authority by behaving as though you have it.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}
