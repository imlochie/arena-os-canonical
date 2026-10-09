// ============================================================================
// Lochie Life College — the class runtime (SERVER ONLY)
// ============================================================================
// LAYER 6 §1 §2 §37 §38.
//
// The College had all the organs. This is the part that makes them operate as
// one thing: the resolution chain from the clock to a session, run BEFORE any
// teaching happens, so the class either begins on a known footing or does not
// begin at all.
//
//   CURRENT TIME → TIMETABLE SLOT → CURRICULUM → COURSE VERSION → OBJECTIVE
//   → FACULTY COMPOSITION → FACULTY VERSIONS → ATTENTION → MEMORY
//   → REAL-WORLD CONTEXT → SESSION
//
// Two principles govern this file.
//
// First, NEVER SILENTLY SUBSTITUTE. A preflight that cannot find a mandatory
// faculty member says so and blocks. It does not quietly promote a different
// member into the gap, because a class taught by an unexpected faculty is
// worse than a class that did not run.
//
// Second, DIAGNOSTIC STATE, NOT A SCORE (§38). The preflight reports the
// condition of each subsystem — valid, degraded, unavailable — and refuses to
// collapse them into a number. "Class health: 7/10" would tell the founder
// nothing about which organ is failing.
// ============================================================================

import { db } from "@/db";
import { collegeContextSignals, collegeCourses, collegeCourseWeeks } from "@/db/college";
import { and, desc, eq } from "drizzle-orm";
import { brisbaneNow, dayName as dayNameFor } from "./time";
import { livePosition, type ResolvedSlot } from "./timetable";
import { getActiveVersion, getCurrentCurriculum } from "./curriculum";
import { effectivePolicies, type EffectivePolicy } from "./attention-resolver";
import { validateRoster, type RosterValidation } from "./members";
import { buildCoordinationGraph, renderGraph, type CoordinationGraph } from "./coordination-graph";
import { getSessionKind } from "./faculty";
import { resolveProtocol } from "./protocol";
import { computeCollegeState, type CollegeState } from "./state";
import * as facultyMemory from "./faculty-memory";
import { resolveAuthority } from "./authority";

/**
 * Mandatory levels that mean "this responsibility cannot be omitted".
 * `optional` and `conditional` do not — mandatory never means always speaking,
 * but it does mean the position must be instantiable.
 */
function isMandatoryLevel(level?: string): boolean {
  return level === "college_wide" || level === "course" || level === "session_type" || level === "phase";
}

// ---------------------------------------------------------------------------
// Diagnostic state — §38
// ---------------------------------------------------------------------------

export type SubsystemState = "valid" | "degraded" | "unavailable" | "not_applicable";

export interface Diagnostic {
  subsystem:
    | "timetable"
    | "curriculum"
    | "course"
    | "objective"
    | "faculty"
    | "authority"
    | "memory"
    | "coordination"
    | "context";
  state: SubsystemState;
  detail: string;
}

export type PreflightSeverity = "ok" | "warn" | "block";

export interface ClassPreflight {
  /** When this preflight was computed, from the application clock. */
  at: { date: string; time: string; dayName: string; timezone: string };

  // ---- WHAT IS SUPPOSED TO BE HAPPENING ----
  slot: {
    id: string | null;
    title: string;
    startTime: string;
    endTime: string;
    activityType: string;
    runtimeStatus: string;
    overrideReason: string | null;
    source: "timetable" | "explicit" | "none";
  };
  theme: string;
  course: {
    id: string | null;
    code: string;
    title: string;
    status: string;
  } | null;
  curriculumVersion: { id: string | null; label: string };
  objective: { weekIndex: number | null; text: string; questionOfWeek: string };

  // ---- WHO IS RESPONSIBLE ----
  faculty: Array<{
    positionKey: string;
    memberName: string;
    memberVersion: number | null;
    mandatory: boolean;
    participation: string;
    defaultState: string;
    effectiveAuthority: string[];
    memoryEnabled: boolean;
  }>;
  mandatoryFaculty: string[];
  optionalFaculty: string[];
  roster: RosterValidation;
  coordination: { graph: CoordinationGraph; rendered: string };

  // ---- WHAT THE COLLEGE KNOWS ----
  relevantMemory: Array<{
    positionKey: string;
    content: string;
    source: string;
    confidence: string;
    evidenceState: string;
  }>;
  realWorldContext: Array<{ signalType: string; content: string; impact: string }>;
  knownConflicts: Array<{ title: string; detail: string; sources: string[] }>;
  timetableOverrides: Array<{ title: string; kind: string; reason: string }>;

  // ---- CAN THIS CLASS BEGIN? ----
  diagnostics: Diagnostic[];
  problems: Array<{ severity: PreflightSeverity; message: string; remedy: string }>;
  severity: PreflightSeverity;
  canBegin: boolean;
  note: string;
}

/**
 * Run the preflight.
 *
 * `courseId` may be supplied explicitly (the founder opening a class directly)
 * or resolved from the live timetable (the College acting on its own schedule).
 * Both paths are legitimate; the preflight records which one was used, because
 * "faculty must not independently decide when a class exists" means the
 * provenance of the decision matters.
 */
export async function preflightClass(opts: {
  courseId?: string | null;
  slotId?: string | null;
  sessionKind?: string;
  weekIndex?: number | null;
  atIso?: string;
  state?: CollegeState;
}): Promise<ClassPreflight> {
  const now = brisbaneNow();
  const sessionKind = opts.sessionKind ?? "lesson";
  const kind = getSessionKind(sessionKind);
  const diagnostics: Diagnostic[] = [];
  const problems: ClassPreflight["problems"] = [];

  const state = opts.state ?? (await computeCollegeState());

  // ---- 1. CLOCK → TIMETABLE SLOT -----------------------------------------
  let slot: ResolvedSlot | null = null;
  let slotSource: "timetable" | "explicit" | "none" = "none";
  const overrides: ClassPreflight["timetableOverrides"] = [];

  try {
    const live = await livePosition(opts.atIso);
    // An explicit slotId wins; otherwise the clock decides.
    if (opts.slotId) {
      slot =
        [...live.completed, ...(live.current ? [live.current] : []), ...live.later].find(
          (s) => s.slotId === opts.slotId
        ) ?? null;
      slotSource = slot ? "explicit" : "none";
    } else if (live.current) {
      slot = live.current;
      slotSource = "timetable";
    }
    for (const s of [...live.completed, ...(live.current ? [live.current] : []), ...live.later]) {
      if (s.override) {
        overrides.push({
          title: s.title,
          kind: s.override.exceptionType,
          reason: s.override.reason,
        });
      }
    }
    diagnostics.push({
      subsystem: "timetable",
      state: slot ? "valid" : "degraded",
      detail: slot
        ? `Resolved "${slot.title}" ${slot.startTime}–${slot.endTime} from the ${slotSource === "explicit" ? "supplied slot" : "application clock"}.`
        : "No timetable slot is active at this moment. A class opened now is unscheduled — legitimate, but recorded as such.",
    });
    if (!slot && !opts.courseId) {
      problems.push({
        severity: "warn",
        message: "No active timetable slot and no course supplied.",
        remedy:
          "This class is unscheduled. It may proceed, and will be recorded as an unscheduled session rather than a timetable deviation.",
      });
    }
  } catch (e) {
    diagnostics.push({
      subsystem: "timetable",
      state: "unavailable",
      detail: `TIMETABLE RESOLUTION FAILURE: ${e instanceof Error ? e.message : String(e)}`,
    });
    problems.push({
      severity: "warn",
      message: "The live timetable could not be resolved.",
      remedy: "The class can still run, but it will not be anchored to a scheduled slot.",
    });
  }

  // ---- 2. CURRICULUM → COURSE --------------------------------------------
  const courseId = opts.courseId ?? slot?.courseId ?? null;
  const version = await getActiveVersion();
  diagnostics.push({
    subsystem: "curriculum",
    state: version ? "valid" : "unavailable",
    detail: version
      ? `Active curriculum version: ${version.label || `v${version.versionNumber}`}.`
      : "No active curriculum version exists.",
  });
  if (!version) {
    problems.push({
      severity: "block",
      message: "No active curriculum version.",
      remedy: "Initialise the curriculum before teaching — a session cannot be pinned to nothing.",
    });
  }

  let course: ClassPreflight["course"] = null;
  if (courseId) {
    const [row] = await db
      .select()
      .from(collegeCourses)
      .where(eq(collegeCourses.id, courseId))
      .limit(1);
    if (row) {
      course = { id: row.id, code: row.code, title: row.title, status: row.status };
      const current = await getCurrentCurriculum();
      const inCurriculum = current.courses.some(
        (c) => String((c as { id: string }).id) === courseId
      );
      const archived = row.status === "archived" || row.status === "retired";
      diagnostics.push({
        subsystem: "course",
        state: archived ? "unavailable" : inCurriculum ? "valid" : "degraded",
        detail: archived
          ? `${row.code} is ${row.status}.`
          : inCurriculum
            ? `${row.code} is active in the current curriculum.`
            : `${row.code} exists but is not a member of the active curriculum version.`,
      });
      if (archived) {
        problems.push({
          severity: "block",
          message: `${row.code} is ${row.status} and cannot be taught.`,
          remedy:
            "Reactivate the course, or teach a different one. Archiving was an institutional decision; the runtime will not quietly override it.",
        });
      } else if (!inCurriculum) {
        problems.push({
          severity: "warn",
          message: `${row.code} is not in the active curriculum version.`,
          remedy:
            "Add it to the curriculum, or proceed knowing this session sits outside the current curriculum.",
        });
      }
    } else {
      diagnostics.push({
        subsystem: "course",
        state: "unavailable",
        detail: "The referenced course does not exist.",
      });
      problems.push({
        severity: "block",
        message: "The supplied course could not be found.",
        remedy: "Check the course id. The runtime will not substitute a different course.",
      });
    }
  } else {
    diagnostics.push({
      subsystem: "course",
      state: "not_applicable",
      detail: "No course is attached to this class.",
    });
  }

  // ---- 3. OBJECTIVE -------------------------------------------------------
  const weekIndex =
    opts.weekIndex ?? (state.position.effectiveWeek.value as number | null) ?? null;
  let objective = { weekIndex, text: "", questionOfWeek: "" };
  if (courseId && weekIndex) {
    const [cw] = await db
      .select()
      .from(collegeCourseWeeks)
      .where(
        and(
          eq(collegeCourseWeeks.courseId, courseId),
          eq(collegeCourseWeeks.weekIndex, weekIndex)
        )
      )
      .limit(1);
    if (cw) {
      objective = {
        weekIndex,
        text: cw.objective,
        questionOfWeek: cw.questionOfWeek,
      };
    }
  }
  diagnostics.push({
    subsystem: "objective",
    state: objective.text ? "valid" : "degraded",
    detail: objective.text
      ? `Week ${weekIndex} objective is recorded.`
      : `No objective is recorded for week ${weekIndex ?? "(unknown)"}. The class can run, but its intent is UNKNOWN rather than assumed.`,
  });

  // ---- 4. FACULTY COMPOSITION + VERSIONS ----------------------------------
  const roster = await validateRoster({
    courseId,
    sessionKind,
    requiredPositions: kind.requiredPositions,
  });

  // Seed from the COURSE PROTOCOL, not merely the session kind's required
  // list. The protocol is what declares which positions are relevant to this
  // course at all — including conditional ones that will stay dormant and
  // administrative ones that only receive. Leaving them out of the graph made
  // legitimate coordination look like a configuration error.
  const protocol = await resolveProtocol(courseId, sessionKind);
  const relevantPositions = [
    ...new Set([...kind.requiredPositions, ...protocol.positions.map((p) => p.positionKey)]),
  ];

  const policies = await effectivePolicies({
    courseId,
    sessionKind,
    slotId: opts.slotId ?? slot?.slotId ?? null,
    positions: relevantPositions,
  });

  const faculty: ClassPreflight["faculty"] = [];
  for (const [key, policy] of policies) {
    const rosterEntry = roster.roster.find((r) => r.positionKey === key);
    const authority = resolveAuthority(key, policy.grantedAuthority);
    faculty.push({
      positionKey: key,
      memberName: policy.memberName || "(no configured member)",
      memberVersion: policy.memberVersion,
      mandatory: isMandatoryLevel(rosterEntry?.mandatoryLevel),
      participation: rosterEntry?.participation ?? "unassigned",
      defaultState: policy.defaultState,
      effectiveAuthority: authority.effective,
      memoryEnabled: policy.memoryEnabled,
    });
  }

  diagnostics.push({
    subsystem: "faculty",
    state: roster.canInitialise ? "valid" : roster.severity === "block" ? "unavailable" : "degraded",
    detail: `${roster.roster.length} position(s) resolved; ${roster.problems.length} problem(s).`,
  });
  for (const message of roster.problems) {
    problems.push({
      severity: roster.severity === "block" ? "block" : "warn",
      message,
      remedy:
        "Configure a member for this position in the Faculty Builder. The runtime will not substitute an unrelated member.",
    });
  }

  // Authority sanity: a position with no effective authority cannot act.
  const powerless = faculty.filter((f) => f.effectiveAuthority.length === 0);
  diagnostics.push({
    subsystem: "authority",
    state: powerless.length ? "degraded" : "valid",
    detail: powerless.length
      ? `${powerless.map((p) => p.positionKey).join(", ")} hold no effective authority and can only be present.`
      : "Every serving position holds at least one effective authority.",
  });

  // ---- 5. COORDINATION GRAPH ---------------------------------------------
  const graph = buildCoordinationGraph(policies);
  diagnostics.push({
    subsystem: "coordination",
    state: graph.edges.length ? "valid" : "degraded",
    detail: `${graph.edges.length} coordination edge(s), ${graph.refused.length} refused.`,
  });

  // ---- 6. RELEVANT MEMORY -------------------------------------------------
  const relevantMemory: ClassPreflight["relevantMemory"] = [];
  let memoryState: SubsystemState = "valid";
  let memoryDetail = "";
  try {
    for (const [key, policy] of policies) {
      if (!policy.memoryEnabled) continue;
      const recalled = await facultyMemory.recall({
        positionKey: key,
        memberId: policy.memberId,
        courseId,
        limit: 3,
        memoryEnabled: true,
      });
      for (const m of recalled) {
        relevantMemory.push({
          positionKey: key,
          content: m.content,
          source: m.source,
          confidence: m.confidence,
          evidenceState:
            m.observationCount >= facultyMemory.FACULTY_MEMORY_CROSSING_THRESHOLD
              ? "corroborated faculty observation"
              : "single faculty observation",
        });
      }
    }
    memoryDetail = relevantMemory.length
      ? `${relevantMemory.length} faculty memory entr(ies) available to this class.`
      : "No faculty memory applies to this class yet.";
  } catch (e) {
    memoryState = "unavailable";
    memoryDetail = `MEMORY RETRIEVAL FAILURE: ${e instanceof Error ? e.message : String(e)}`;
    problems.push({
      severity: "warn",
      message: "Faculty memory could not be retrieved.",
      remedy: "The class can proceed. Faculty will teach without their prior observations.",
    });
  }
  diagnostics.push({ subsystem: "memory", state: memoryState, detail: memoryDetail });

  // ---- 7. REAL-WORLD CONTEXT ---------------------------------------------
  const signals = await db
    .select()
    .from(collegeContextSignals)
    .where(eq(collegeContextSignals.active, true))
    .orderBy(desc(collegeContextSignals.createdAt))
    .limit(6);
  const realWorldContext = signals.map((s) => ({
    signalType: s.signalType,
    content: s.content,
    impact: s.impact ?? "",
  }));
  diagnostics.push({
    subsystem: "context",
    state: realWorldContext.length ? "degraded" : "valid",
    detail: realWorldContext.length
      ? `${realWorldContext.length} real-world condition(s) declared. Conditions are modified, not normal.`
      : "No real-world conditions declared. Operating normally.",
  });

  // ---- 8. CAN THIS BEGIN? -------------------------------------------------
  // A degraded subsystem is not a problem, but it is not "all valid" either.
  // Saying so plainly matters more than a tidy green line.
  const degraded = diagnostics.filter((d) => d.state === "degraded" || d.state === "unavailable");

  const severity: PreflightSeverity = problems.some((p) => p.severity === "block")
    ? "block"
    : problems.some((p) => p.severity === "warn")
      ? "warn"
      : "ok";

  return {
    at: {
      date: now.isoDate,
      time: `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
      dayName: dayNameFor(now.dayOfWeek),
      timezone: "Australia/Brisbane",
    },
    slot: {
      id: slot?.slotId ?? opts.slotId ?? null,
      title: slot?.title ?? "(unscheduled)",
      startTime: slot?.startTime ?? "",
      endTime: slot?.endTime ?? "",
      activityType: slot?.activityType ?? "academic",
      runtimeStatus: slot?.runtimeStatus ?? "unknown",
      overrideReason: slot?.override?.reason ?? null,
      source: slotSource,
    },
    theme: state.position.weekTheme?.value != null ? String(state.position.weekTheme.value) : "",
    course,
    curriculumVersion: {
      id: version?.id ?? null,
      label: version?.label ?? "(none)",
    },
    objective,
    faculty,
    mandatoryFaculty: faculty.filter((f) => f.mandatory).map((f) => f.positionKey),
    optionalFaculty: faculty.filter((f) => !f.mandatory).map((f) => f.positionKey),
    roster,
    coordination: { graph, rendered: renderGraph(graph) },
    relevantMemory,
    realWorldContext,
    knownConflicts: state.conflicts.map((c) => ({
      title: c.title,
      detail: c.detail,
      sources: c.sources,
    })),
    timetableOverrides: overrides,
    diagnostics,
    problems,
    severity,
    canBegin: severity !== "block",
    note:
      severity === "block"
        ? "SESSION CANNOT FULLY INITIALISE. The problems above are structural. Nothing has been substituted — resolve them, or proceed deliberately with force:true and the gap recorded."
        : severity === "warn"
          ? "The class can begin. The conditions above are recorded so this session is interpreted against what was actually true at the time."
          : degraded.length
            ? `The class can begin. No problems block it, but ${degraded
                .map((d) => d.subsystem)
                .join(", ")} ${degraded.length === 1 ? "is" : "are"} operating in a degraded state — recorded so this session is read against what was actually true.`
            : "All subsystems valid. The class can begin on a known footing.",
  };
}

/**
 * Render the preflight as the brief prints it (§2).
 * Used by the API and the Day view; kept here so there is one wording.
 */
export function renderPreflight(p: ClassPreflight): string {
  const L: string[] = [];
  L.push(`CLASS           ${p.slot.title}`);
  L.push(`COURSE          ${p.course ? `${p.course.code} — ${p.course.title}` : "(none)"}`);
  L.push(`DATE            ${p.at.dayName} ${p.at.date}`);
  L.push(
    `TIME            ${p.slot.startTime || p.at.time}${p.slot.endTime ? `–${p.slot.endTime}` : ""} ${p.at.timezone}`
  );
  L.push(`THEME           ${p.theme || "(none recorded)"}`);
  L.push(`CURRICULUM      ${p.curriculumVersion.label}`);
  L.push(`GOAL            ${p.objective.text || "(UNKNOWN — no objective recorded)"}`);
  L.push("");
  L.push("FACULTY");
  for (const f of p.faculty) {
    L.push(
      `  ${f.mandatory ? "[mandatory]" : "[optional] "} ${f.positionKey.padEnd(11)} ${f.memberName}${
        f.memberVersion ? ` v${f.memberVersion}` : ""
      } — opens ${f.defaultState}`
    );
  }
  L.push("");
  L.push(`REAL-WORLD CONTEXT   ${p.realWorldContext.length ? "" : "none declared"}`);
  for (const c of p.realWorldContext) L.push(`  · [${c.signalType}] ${c.content}`);
  L.push(`RELEVANT MEMORY      ${p.relevantMemory.length ? "" : "none"}`);
  for (const m of p.relevantMemory) L.push(`  · (${m.positionKey}) ${m.content}`);
  L.push(`KNOWN CONFLICTS      ${p.knownConflicts.length ? "" : "none"}`);
  for (const c of p.knownConflicts) L.push(`  ! ${c.title}: ${c.detail}`);
  L.push(`TIMETABLE OVERRIDES  ${p.timetableOverrides.length ? "" : "none"}`);
  for (const o of p.timetableOverrides) L.push(`  · ${o.title} — ${o.kind}: ${o.reason}`);
  L.push("");
  L.push("DIAGNOSTICS");
  for (const d of p.diagnostics) {
    L.push(`  ${d.subsystem.toUpperCase().padEnd(13)} ${d.state.padEnd(15)} ${d.detail}`);
  }
  if (p.problems.length) {
    L.push("");
    L.push("PROBLEMS");
    for (const pr of p.problems) L.push(`  [${pr.severity.toUpperCase()}] ${pr.message}\n      → ${pr.remedy}`);
  }
  L.push("");
  L.push(p.note);
  return L.join("\n");
}

export type { EffectivePolicy };
