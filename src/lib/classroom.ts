// Classroom runtime — Lochie Life College classes as orchestrated
// collaborations.
//
// Reuses the Collaboration Orchestrator as the canonical execution unit
// (no second session lifecycle): starting a class creates/resumes a
// Collaboration for today's occurrence; each bounded advance step either
// dispatches one pending relay (faculty work), surfaces a student
// checkpoint, or transitions the class to its next phase. The student
// experiences one Faculty-led lesson; the perspectives (Critic, Researcher,
// Pragmatist, Steward) collaborate behind the classroom.

import { db } from "@/db";
import { artifacts } from "@/db/schema";
import {
  COLLEGE, SEMESTER, FACULTIES, resolveCollegeState, localDateStr,
  getOccurrenceByDate, saveOccurrence, latestCompleteOccurrenceBefore,
  listEduMemory, addEduMemory, deleteOccurrence,
  type ClassOccurrence, type ResolvedClass, type EduMemoryEntry,
} from "@/lib/college";
import {
  createCollaboration, advanceCollaboration, addRelay, getCollaboration,
  respondToRelay, type Collaboration, type Relay, type OrchestratorKeys,
} from "@/lib/orchestrator";

export { localDateStr, deleteOccurrence, type ClassOccurrence, type ResolvedClass, type EduMemoryEntry };

export type ClassroomAdvance =
  | "not-started" | "relay" | "checkpoint" | "phase" | "complete" | "closed";

export interface ClassroomAdvanceResult {
  ran: ClassroomAdvance;
  note: string;
  state: ClassroomState;
}

export interface ClassroomState {
  college: typeof COLLEGE;
  semester: { name: string; week1Monday: string };
  resolved: ResolvedClass;
  occurrence: ClassOccurrence | null;
  collaboration: Collaboration | null;
  pendingCheckpoint: Relay | null;
  previousRecord: EduMemoryEntry | null;
  memory: EduMemoryEntry[];
  courses: { code: string; name: string; curriculum: { week: number; title: string }[]; state: string }[];
}

const PARTICIPANTS = (facultyName: string, methods: string[]) => [
  { key: "faculty-lead", name: `${facultyName} Lead`, emoji: "🎓", kind: "model" as const, capabilities: ["teaching", ...methods] },
  { key: "critic", name: "Socratic Critic", emoji: "❓", kind: "model" as const, capabilities: ["probing", "assessment"] },
  { key: "researcher", name: "Researcher", emoji: "🔎", kind: "model" as const, capabilities: ["research", "tool_use"] },
  { key: "pragmatist", name: "Pragmatist", emoji: "🛠️", kind: "model" as const, capabilities: ["exercises", "practical translation"] },
  { key: "steward", name: "Steward", emoji: "🛡️", kind: "model" as const, capabilities: ["owner interest", "boundaries"] },
  { key: "student", name: "Student", emoji: "🧑", kind: "human" as const, capabilities: ["participation", "decisions"] },
];

function themeLine(resolved: ResolvedClass): string {
  if (resolved.weekState === "before") return `Academic week: not yet commenced (${resolved.weekNote})`;
  if (resolved.weekState === "beyond") return `Academic week: ${resolved.weekNumber} — ${resolved.weekNote}`;
  return `Academic week: ${resolved.weekNumber} of ${SEMESTER.name} — theme: ${resolved.weekTheme ?? "not documented"}.`;
}

async function buildCollaborationContext(resolved: ResolvedClass, prevRecord: EduMemoryEntry | null, memory: EduMemoryEntry[]): Promise<string> {
  const faculty = resolved.faculty;
  const sections = [
    `INSTITUTION: ${COLLEGE.name} — "${COLLEGE.philosophy}" · motto: "${COLLEGE.motto}" · principle: "${COLLEGE.principle}"`,
    `SEMESTER: ${SEMESTER.name} (Week 1 Monday = ${SEMESTER.week1Monday})`,
    `TODAY: ${resolved.weekday} — ${resolved.classroom.name}: ${resolved.classroom.purpose}`,
    themeLine(resolved),
    `FACULTY: ${faculty.name} — subject: ${faculty.subjectDomain}. Teaching methods: ${faculty.methodsDocumented ? faculty.methods.join(", ") : `${faculty.methods.length ? faculty.methods.join(", ") + " " : ""}(not fully documented — definition required; do not invent College-specific pedagogy, teach toward the documented purpose)`}`,
  ];
  if (prevRecord) {
    sections.push(`PREVIOUS LESSON RECORD (${prevRecord.classroomKey}, week ${prevRecord.weekNumber ?? "?"}):\n${prevRecord.content.slice(0, 1500)}`);
  } else {
    sections.push("PREVIOUS LESSON RECORD: (none — this is the first documented occurrence for this classroom)");
  }
  if (memory.length) {
    sections.push(
      "EDUCATIONAL MEMORY (what should carry forward):\n" +
        memory.slice(0, 8).map((m) => `- [${m.kind}] ${m.content.slice(0, 220)}`).join("\n")
    );
  }
  return sections.join("\n\n").slice(0, 6000);
}

export async function getClassroomState(dateStr: string): Promise<ClassroomState> {
  const resolved = resolveCollegeState(dateStr);
  const occurrence = await getOccurrenceByDate(dateStr);
  const collaboration = occurrence?.collaborationId ? await getCollaboration(occurrence.collaborationId) : null;
  const prevOcc = await latestCompleteOccurrenceBefore(dateStr, resolved.classroom.key);
  const prevMemory = prevOcc
    ? (await listEduMemory(resolved.classroom.key, 50)).find((m) => m.sourceOccurrenceId === prevOcc.id && m.kind === "record") ?? null
    : null;
  const pendingCheckpoint =
    collaboration?.relays.find(
      (r) =>
        r.status === "pending" &&
        collaboration.participants.find((p) => p.key === r.targetKey)?.kind === "human"
    ) ?? null;
  return {
    college: COLLEGE,
    semester: { name: SEMESTER.name, week1Monday: SEMESTER.week1Monday },
    resolved,
    occurrence,
    collaboration,
    pendingCheckpoint,
    previousRecord: prevMemory,
    memory: await listEduMemory(resolved.classroom.key, 10),
    courses: (await import("@/lib/college")).COURSES,
  };
}

// ---------------- start ----------------

export async function startClass(
  dateStr: string,
  opts: { keys?: OrchestratorKeys; localOnly?: boolean } = {}
): Promise<ClassroomState> {
  const resolved = resolveCollegeState(dateStr);
  const existing = await getOccurrenceByDate(dateStr);
  if (existing && existing.status !== "waiting") return getClassroomState(dateStr); // resume

  const prevOcc = await latestCompleteOccurrenceBefore(dateStr, resolved.classroom.key);
  const prevRecord = prevOcc
    ? (await listEduMemory(resolved.classroom.key, 50)).find((m) => m.sourceOccurrenceId === prevOcc.id && m.kind === "record") ?? null
    : null;
  const memory = await listEduMemory(resolved.classroom.key, 10);
  const context = await buildCollaborationContext(resolved, prevRecord, memory);

  const collaboration = await createCollaboration({
    title: `🎓 ${resolved.classroom.name} — ${resolved.isoDate} (Week ${resolved.weekNumber})`,
    goal:
      `Conduct today's ${resolved.classroom.name} class${resolved.weekTheme ? ` on the week theme "${resolved.weekTheme}"` : ""} ` +
      "for the student: teach, practice, check understanding, and reflect — in the student's best interest, within the College's documented curriculum.",
    context,
    autoRoute: false, // the class state machine IS the conductor here
    participants: PARTICIPANTS(resolved.faculty.name, resolved.faculty.methods),
  });

  const occurrence: ClassOccurrence = existing ?? {
    id: globalThis.crypto?.randomUUID?.() ?? `o${Date.now().toString(36)}`,
    date: dateStr,
    classroomKey: resolved.classroom.key,
    weekNumber: resolved.weekNumber,
    phase: "waiting",
    status: "waiting",
    collaborationId: null,
    openedAt: null,
    closedAt: null,
  };
  occurrence.collaborationId = collaboration.id;
  occurrence.status = "in_session";
  occurrence.phase = "orientation";
  occurrence.openedAt = new Date().toISOString();
  await saveOccurrence(occurrence);

  await queuePhase("orientation", collaboration.id, resolved);
  return getClassroomState(dateStr);
}

// ---------------- phase relays ----------------

async function queuePhase(phase: string, collaborationId: string, resolved: ResolvedClass): Promise<void> {
  const faculty = resolved.faculty;
  const theme = resolved.weekTheme;
  const themeRef = theme ? `the week theme "${theme}"` : "today's documented classroom purpose (no week theme is documented — do not invent one)";
  switch (phase) {
    case "orientation":
      await addRelay(collaborationId, {
        target: "faculty-lead",
        purpose: "orientation",
        request:
          `Open today's ${resolved.classroom.name} class for Week ${resolved.weekNumber}. Greet the student in the spirit of ${COLLEGE.name} ` +
          `("${COLLEGE.philosophy}"), state ${themeRef}, state today's objective, connect to the previous lesson record in the context if present, ` +
          "and outline what today covers. Under 150 words. You are the one voice of the Faculty — the other positions work behind the classroom.",
        responseContract: "brief class opening in markdown",
      });
      break;
    case "lesson":
      await addRelay(collaborationId, {
        target: "faculty-lead",
        purpose: "teach",
        request:
          `Teach today's lesson on ${themeRef}, using your methods${faculty.methodsDocumented ? `: ${faculty.methods.join(", ")}` : " (adapt honestly to the documented classroom purpose)"}. ` +
          "Stay connected to the previous lesson record and educational memory in the context. Concise, structured markdown the student can act on.",
        responseContract: "lesson in markdown",
      });
      await addRelay(collaborationId, {
        target: "researcher",
        purpose: "evidence",
        toolUse: true,
        request:
          `Inspect the workspace through your read-only tools and surface ONE concrete example relevant to ${themeRef} ` +
          "that the Faculty Lead could use to ground the lesson. If nothing relevant exists, say so plainly rather than inventing an example.",
        responseContract: "one concrete example, or an honest 'nothing found'",
      });
      break;
    case "practice":
      await addRelay(collaborationId, {
        target: "pragmatist",
        purpose: "exercise",
        request:
          `Design ONE small exercise for today's lesson (${themeRef}) the student can complete in 10–15 minutes. ` +
          "State the exercise, its success criterion, and how it connects to the lesson above. Adapt to any context the student has shared.",
        responseContract: "exercise spec",
      });
      break;
    case "discussion":
      await addRelay(collaborationId, {
        target: "student",
        purpose: "discussion",
        request:
          "Today's lesson and exercise are above. Your turn: respond, work through the exercise out loud, or ask the Faculty anything. " +
          "This is your class — participate as the student.",
        responseContract: "student participation",
      });
      break;
    case "check":
      await addRelay(collaborationId, {
        target: "critic",
        purpose: "probe",
        request:
          "From the student's discussion response above, assess their understanding of today's concept: what landed, what's shaky. " +
          "Then pose exactly ONE Socratic question that probes the weakest point. Do not grade — the College does not invent grades.",
        responseContract: "assessment + one question",
      });
      await addRelay(collaborationId, {
        target: "student",
        purpose: "answer",
        request: "The Socratic Critic has posed a question above. Answer it in your own words.",
        responseContract: "student answer",
      });
      break;
    case "reflection":
      await addRelay(collaborationId, {
        target: "student",
        purpose: "reflection",
        request:
          "Reflect on today's class: what did you take from it, and what should the next occurrence build on? " +
          "Your words become part of the educational record the Faculty carries forward.",
        responseContract: "student reflection",
      });
      break;
    case "record":
      await addRelay(collaborationId, {
        target: "faculty-lead",
        purpose: "teaching-record",
        request:
          "Write the Faculty Reflection & Teaching Record for today's occurrence: what was taught, what was actually accomplished, " +
          "student observations and difficulties, exercises completed, follow-up required, and implications for the next occurrence. " +
          "Include what was scheduled vs. what happened if the class adapted. Structured markdown. No grades.",
        responseContract: "teaching record",
      });
      break;
  }
}

// ---------------- advance (one bounded step) ----------------

export async function advanceClass(
  dateStr: string,
  opts: { keys?: OrchestratorKeys; localOnly?: boolean } = {}
): Promise<ClassroomAdvanceResult> {
  const resolved = resolveCollegeState(dateStr);
  const occurrence = await getOccurrenceByDate(dateStr);
  if (!occurrence || occurrence.status === "waiting") {
    return {
      ran: "not-started",
      note: "Today's class hasn't been started yet — start it first.",
      state: await getClassroomState(dateStr),
    };
  }
  if (occurrence.status === "complete") {
    return { ran: "complete", note: "Today's class is complete — the record is filed.", state: await getClassroomState(dateStr) };
  }

  const collab = occurrence.collaborationId ? await getCollaboration(occurrence.collaborationId) : null;
  if (!collab) {
    return { ran: "closed", note: "The class collaboration is missing.", state: await getClassroomState(dateStr) };
  }

  // 1) dispatch one pending relay (or surface the student checkpoint)
  const pending = collab.relays.filter((r) => r.status === "pending").sort((a, b) => a.seq - b.seq)[0];
  if (pending) {
    const result = await advanceCollaboration(collab.id, opts);
    if (!result) {
      return { ran: "closed", note: "The class collaboration is missing.", state: await getClassroomState(dateStr) };
    }
    return {
      ran: result.ran === "checkpoint" ? "checkpoint" : result.ran === "blocked-relay" ? "closed" : "relay",
      note: result.note,
      state: await getClassroomState(dateStr),
    };
  }

  // 2) no pending relays → transition to the next phase
  const order = ["waiting", "orientation", "lesson", "practice", "discussion", "check", "reflection", "record", "complete"];
  const nextIndex = order.indexOf(occurrence.phase) + 1;
  const next = order[nextIndex] ?? "complete";

  if (next === "complete") {
    await finalizeOccurrence(occurrence, collab, resolved);
    return {
      ran: "complete",
      note: "Class complete — the Faculty Reflection & Teaching Record is filed and carried to the next occurrence.",
      state: await getClassroomState(dateStr),
    };
  }

  await queuePhase(next, collab.id, resolved);
  occurrence.phase = next as ClassOccurrence["phase"];
  await saveOccurrence(occurrence);
  return {
    ran: "phase",
    note: `Class moving to: ${next}.`,
    state: await getClassroomState(dateStr),
  };
}

async function finalizeOccurrence(occurrence: ClassOccurrence, collab: Collaboration, resolved: ResolvedClass): Promise<void> {
  const byPurpose = (purpose: string) => collab.relays.find((r) => r.purpose === purpose && r.status === "responded");

  const lesson = byPurpose("teach");
  if (lesson?.response) {
    await addEduMemory({
      classroomKey: occurrence.classroomKey, weekNumber: occurrence.weekNumber, kind: "lesson",
      content: lesson.response.slice(0, 4000), sourceOccurrenceId: occurrence.id,
    });
  }
  const reflection = byPurpose("reflection");
  if (reflection?.response) {
    await addEduMemory({
      classroomKey: occurrence.classroomKey, weekNumber: occurrence.weekNumber, kind: "reflection",
      content: reflection.response.slice(0, 4000), sourceOccurrenceId: occurrence.id,
    });
  }
  const record = byPurpose("teaching-record");
  const recordContent = record?.response?.slice(0, 8000) ?? "(no record produced)";
  await addEduMemory({
    classroomKey: occurrence.classroomKey, weekNumber: occurrence.weekNumber, kind: "record",
    content: recordContent, sourceOccurrenceId: occurrence.id,
  });

  try {
    await db.insert(artifacts).values({
      kind: "decision",
      title: `🎓 Teaching record — ${resolved.classroom.name} ${occurrence.date} (Week ${occurrence.weekNumber})`,
      body:
        `**${COLLEGE.name} · ${resolved.classroom.name} · Week ${occurrence.weekNumber}${resolved.weekTheme ? ` — ${resolved.weekTheme}` : ""}**\n\n` +
        `**Faculty:** ${resolved.faculty.name}\n\n${recordContent}`.slice(0, 20000),
      sourceType: "classroom",
      sourceId: occurrence.id,
    });
  } catch {
    /* artifact filing is best-effort (no DB in local mode) */
  }

  occurrence.phase = "complete";
  occurrence.status = "complete";
  occurrence.closedAt = new Date().toISOString();
  await saveOccurrence(occurrence);
}

// ---------------- student participation ----------------

export async function respondStudent(
  relayId: string,
  input: { response?: string; rejected?: boolean }
): Promise<Relay | null> {
  return respondToRelay(relayId, input);
}
