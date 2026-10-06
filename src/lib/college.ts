// Lochie Life College — the institutional domain and the ONE authoritative
// current-class resolver.
//
// The College is durable institutional state, not a prompt: identity,
// academic calendar, timetable, courses, and faculties live here as data.
// The resolver answers, from a date alone: which academic week is it, which
// class is scheduled, which Faculty owns it — so the student never has to
// explain what class it is (the product test in the brief).
//
// NO-FABRICATION RULE (brief §24): only documented College material is
// encoded. Week themes beyond Week 10, FIN111's curriculum, and teaching
// methods for faculties the College material doesn't cover are represented
// as explicitly missing ("definition required"), never invented.
//
// House pattern: Postgres when available, in-memory fallback otherwise.

import { db } from "@/db";
import { classOccurrences, eduMemory } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

// ---------------- institutional identity (documented) ----------------

export const COLLEGE = {
  name: "Lochie Life College",
  nature: "A personal university / life operating system.",
  philosophy: "Become by Learning",
  motto: "That's Life",
  principle: "I cannot imitate what I do not know.",
  values: [
    "observation",
    "learning through experience",
    "pattern recognition",
    "reflection",
    "experimentation",
    "personal systems",
    "creative practice",
    "alignment",
    "integration",
    "continuous development",
  ],
} as const;

export const SEMESTER = {
  name: "Semester I — Foundations",
  week1Monday: "2026-07-06", // Week 1 Monday (documented commencement)
  weeklyThemes: [
    { week: 1, theme: "Observation" },
    { week: 2, theme: "Patterns" },
    { week: 3, theme: "Friction" },
    { week: 4, theme: "Design" },
    { week: 5, theme: "Rhythm" },
    { week: 6, theme: "Attention" },
    { week: 7, theme: "Feedback" },
    { week: 8, theme: "Recovery" },
    { week: 9, theme: "Alignment" },
    { week: 10, theme: "Integration" },
  ],
} as const;

export interface TimetableSlot {
  day: number; // 1 = Monday … 7 = Sunday
  key: string;
  name: string;
  purpose: string;
}

export const TIMETABLE: TimetableSlot[] = [
  { day: 1, key: "reset", name: "RESET", purpose: "Creative / music reset and beginning-of-week reset." },
  { day: 2, key: "explore", name: "EXPLORE", purpose: "Digital Lab / exploration." },
  { day: 3, key: "adulting", name: "ADULTING", purpose: "Life administration, practical adult skills, personal systems." },
  { day: 4, key: "create", name: "CREATE", purpose: "Instrument practice / creative production." },
  { day: 5, key: "kickoff", name: "KICKOFF", purpose: "Weekend preparation and transition." },
  { day: 6, key: "adventure", name: "ADVENTURE", purpose: "Experience, exploration, activity, real-world learning." },
  { day: 7, key: "soul", name: "SOUL", purpose: "Reflection, integration, inner life, recovery, meaning." },
];

// ---------------- courses (documented pilots only) ----------------

export interface CourseDef {
  code: string;
  name: string;
  curriculum: { week: number; title: string }[];
  state: string; // honest state — "definition required" when undocumented
}

export const COURSES: CourseDef[] = [
  {
    code: "PSY110",
    name: "Personal Systems",
    curriculum: [{ week: 1, title: "Meet Yourself" }],
    state: "active pilot — curriculum beyond Week 1 not documented",
  },
  {
    code: "FIN111",
    name: "Personal Finance Foundations",
    curriculum: [],
    state: "definition required — curriculum not documented",
  },
];

// ---------------- faculties (persistent teaching identities) ----------------

export interface FacultyDef {
  key: string; // matches the timetable classroom key it teaches
  name: string;
  subjectDomain: string;
  methods: string[]; // documented pedagogical positions; empty = not documented
  methodsDocumented: boolean;
}

const NOT_DOCUMENTED = "teaching methods not documented — definition required";

export const FACULTIES: Record<string, FacultyDef> = {
  reset: {
    key: "reset",
    name: "Reset Faculty",
    subjectDomain: "Creative / music reset and beginning-of-week reset",
    methods: [],
    methodsDocumented: false,
  },
  explore: {
    key: "explore",
    name: "Digital Lab Faculty",
    subjectDomain: "Digital Lab / exploration",
    methods: ["explain", "demonstrate", "build", "debug", "test", "review"],
    methodsDocumented: true,
  },
  adulting: {
    key: "adulting",
    name: "Personal Systems Faculty",
    subjectDomain: "Life administration, practical adult skills, personal systems",
    methods: ["observe", "question", "identify patterns", "experiment", "reflect"],
    methodsDocumented: true,
  },
  create: {
    key: "create",
    name: "Creative Practice Faculty",
    subjectDomain: "Instrument practice / creative production",
    methods: ["demonstrate", "observe", "experiment", "critique", "iterate"],
    methodsDocumented: true,
  },
  kickoff: {
    key: "kickoff",
    name: "Kickoff Faculty",
    subjectDomain: "Weekend preparation and transition",
    methods: [],
    methodsDocumented: false,
  },
  adventure: {
    key: "adventure",
    name: "Adventure Faculty",
    subjectDomain: "Experience, exploration, activity, real-world learning",
    methods: [],
    methodsDocumented: false,
  },
  soul: {
    key: "soul",
    name: "Reflection Faculty",
    subjectDomain: "Reflection, integration, inner life, recovery, meaning",
    methods: ["listen", "question", "connect", "reflect", "integrate"],
    methodsDocumented: true,
  },
};

// ---------------- the authoritative resolver ----------------

export type WeekState = "before" | "within" | "beyond";

export interface ResolvedClass {
  isoDate: string; // YYYY-MM-DD
  weekday: string; // Monday…Sunday
  classroom: TimetableSlot;
  faculty: FacultyDef;
  weekNumber: number; // 1-based; may be <1 or >10 (see weekState)
  weekState: WeekState;
  weekTheme: string | null; // null = not documented — never invented
  weekNote: string; // honest explanation for the UI
}

function toDate(dateStr: string): Date {
  // parse as local midnight — dates are institutional (local), not instants
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function localDateStr(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** THE resolver — one authoritative implementation, no duplicates anywhere. */
export function resolveCollegeState(dateStr: string): ResolvedClass {
  const date = toDate(dateStr);
  const weekdayIndex = date.getDay() === 0 ? 7 : date.getDay(); // 1=Mon … 7=Sun
  const classroom = TIMETABLE.find((slot) => slot.day === weekdayIndex)!;
  const faculty = FACULTIES[classroom.key];

  const monday = new Date(date);
  monday.setDate(monday.getDate() - (weekdayIndex - 1));
  const week1 = toDate(SEMESTER.week1Monday);
  const weekNumber = Math.floor(daysBetween(week1, monday) / 7) + 1;

  let weekState: WeekState = "within";
  let weekTheme: string | null = null;
  let weekNote = "";
  if (daysBetween(date, week1) > 0 || (daysBetween(date, week1) === 0 && false)) {
    // before commencement (any date strictly before the Week 1 Monday)
    weekState = "before";
    weekNote = `Semester I commences ${SEMESTER.week1Monday} (Week 1 Monday). The academic calendar has not started.`;
  } else if (weekNumber > SEMESTER.weeklyThemes.length) {
    weekState = "beyond";
    weekNote =
      `Week ${weekNumber} is beyond the documented Semester I curriculum (Weeks 1–10). ` +
      "No theme is invented for undocumented weeks — the College marks this as incomplete rather than fabricating institutional facts.";
  } else {
    weekTheme = SEMESTER.weeklyThemes.find((w) => w.week === weekNumber)?.theme ?? null;
    weekNote = weekTheme
      ? `Week ${weekNumber} of ${SEMESTER.name} — theme: ${weekTheme}.`
      : `Week ${weekNumber} theme is not documented in the Semester I curriculum.`;
  }

  return {
    isoDate: toIsoDate(date),
    weekday: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][weekdayIndex - 1],
    classroom,
    faculty,
    weekNumber,
    weekState,
    weekTheme,
    weekNote,
  };
}

// ---------------- occurrence + educational memory stores ----------------

export type OccurrencePhase =
  | "waiting" | "orientation" | "lesson" | "practice"
  | "discussion" | "check" | "reflection" | "record" | "complete";

export const OCCURRENCE_PHASES: OccurrencePhase[] = [
  "waiting", "orientation", "lesson", "practice",
  "discussion", "check", "reflection", "record", "complete",
];

export interface ClassOccurrence {
  id: string;
  date: string;
  classroomKey: string;
  weekNumber: number;
  phase: OccurrencePhase;
  status: "waiting" | "in_session" | "complete";
  collaborationId: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface EduMemoryEntry {
  id: string;
  classroomKey: string;
  weekNumber: number | null;
  kind: string;
  content: string;
  sourceOccurrenceId: string | null;
  createdAt: string;
}

const memoryOccurrences = new Map<string, ClassOccurrence>();
const memoryEdu = new Map<string, EduMemoryEntry>();
let dbHealthy = true;
let tablesReady = false;

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "class_occurrences" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "date" text NOT NULL,
        "classroom_key" text NOT NULL,
        "week_number" integer NOT NULL,
        "phase" text DEFAULT 'waiting' NOT NULL,
        "status" text DEFAULT 'waiting' NOT NULL,
        "collaboration_id" uuid,
        "opened_at" timestamp,
        "closed_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "class_occurrences_date_idx" ON "class_occurrences" ("date");`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "edu_memory" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "classroom_key" text NOT NULL,
        "week_number" integer,
        "kind" text DEFAULT 'observation' NOT NULL,
        "content" text NOT NULL,
        "source_occurrence_id" uuid,
        "collaboration_id" uuid,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tablesReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
}

function occurrenceFromRow(r: typeof classOccurrences.$inferSelect): ClassOccurrence {
  return {
    id: r.id,
    date: r.date,
    classroomKey: r.classroomKey,
    weekNumber: r.weekNumber,
    phase: (OCCURRENCE_PHASES.includes(r.phase as OccurrencePhase) ? r.phase : "waiting") as OccurrencePhase,
    status: (["waiting", "in_session", "complete"].includes(r.status) ? r.status : "waiting") as ClassOccurrence["status"],
    collaborationId: r.collaborationId ?? null,
    openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null,
    closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
  };
}

export async function getOccurrenceByDate(dateStr: string): Promise<ClassOccurrence | null> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(classOccurrences).where(eq(classOccurrences.date, dateStr)).limit(1);
      if (rows.length) return occurrenceFromRow(rows[0]);
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  for (const occ of memoryOccurrences.values()) {
    if (occ.date === dateStr) return occ;
  }
  return null;
}

export async function saveOccurrence(occ: ClassOccurrence): Promise<void> {
  try {
    await ensureTables();
    if (dbHealthy) {
      await db
        .insert(classOccurrences)
        .values({
          id: occ.id, date: occ.date, classroomKey: occ.classroomKey, weekNumber: occ.weekNumber,
          phase: occ.phase, status: occ.status, collaborationId: occ.collaborationId,
          openedAt: occ.openedAt ? new Date(occ.openedAt) : null, closedAt: occ.closedAt ? new Date(occ.closedAt) : null,
        })
        .onConflictDoUpdate({
          target: classOccurrences.date,
          set: {
            phase: occ.phase, status: occ.status, collaborationId: occ.collaborationId,
            openedAt: occ.openedAt ? new Date(occ.openedAt) : null,
            closedAt: occ.closedAt ? new Date(occ.closedAt) : null,
            updatedAt: new Date(),
          },
        });
    }
  } catch {
    dbHealthy = false;
  }
  memoryOccurrences.set(occ.date, occ);
}

export async function latestCompleteOccurrenceBefore(dateStr: string, classroomKey: string): Promise<ClassOccurrence | null> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db
        .select()
        .from(classOccurrences)
        .where(eq(classOccurrences.classroomKey, classroomKey))
        .orderBy(desc(classOccurrences.date))
        .limit(50);
      const match = rows.map(occurrenceFromRow).find((o) => o.date < dateStr && o.status === "complete");
      if (match) return match;
    }
  } catch {
    dbHealthy = false;
  }
  const candidates = [...memoryOccurrences.values()]
    .filter((o) => o.classroomKey === classroomKey && o.date < dateStr && o.status === "complete")
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return candidates[0] ?? null;
}

export async function listOccurrences(limit = 20): Promise<ClassOccurrence[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(classOccurrences).orderBy(desc(classOccurrences.date)).limit(limit);
      return rows.map(occurrenceFromRow);
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryOccurrences.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
}

// ---- educational memory ----

export async function addEduMemory(entry: Omit<EduMemoryEntry, "id" | "createdAt">): Promise<EduMemoryEntry> {
  const full: EduMemoryEntry = { ...entry, id: newId(), createdAt: new Date().toISOString() };
  try {
    await ensureTables();
    if (dbHealthy) {
      const [row] = await db
        .insert(eduMemory)
        .values({
          classroomKey: full.classroomKey, weekNumber: full.weekNumber, kind: full.kind,
          content: full.content.slice(0, 8000), sourceOccurrenceId: full.sourceOccurrenceId,
        })
        .returning();
      if (row) full.id = row.id;
    }
  } catch {
    dbHealthy = false;
  }
  memoryEdu.set(full.id, full);
  return full;
}

export async function listEduMemory(classroomKey?: string, limit = 20): Promise<EduMemoryEntry[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(eduMemory).orderBy(desc(eduMemory.createdAt)).limit(200);
      return rows
        .map((r) => ({
          id: r.id, classroomKey: r.classroomKey, weekNumber: r.weekNumber ?? null, kind: r.kind,
          content: r.content, sourceOccurrenceId: r.sourceOccurrenceId ?? null,
          createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
        }))
        .filter((e) => !classroomKey || e.classroomKey === classroomKey)
        .slice(0, limit);
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryEdu.values()]
    .filter((e) => !classroomKey || e.classroomKey === classroomKey)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export async function deleteEduMemoryByOccurrence(occurrenceId: string): Promise<void> {
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.delete(eduMemory).where(eq(eduMemory.sourceOccurrenceId, occurrenceId));
    }
  } catch {
    dbHealthy = false;
  }
  for (const [id, entry] of memoryEdu) {
    if (entry.sourceOccurrenceId === occurrenceId) memoryEdu.delete(id);
  }
}

export async function deleteOccurrence(dateStr: string): Promise<boolean> {
  const occ = await getOccurrenceByDate(dateStr);
  if (!occ) return false;
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.delete(eduMemory).where(eq(eduMemory.sourceOccurrenceId, occ.id));
      await db.delete(classOccurrences).where(eq(classOccurrences.date, dateStr));
    }
  } catch {
    dbHealthy = false;
  }
  memoryOccurrences.delete(dateStr);
  for (const [id, entry] of memoryEdu) {
    if (entry.sourceOccurrenceId === occ.id) memoryEdu.delete(id);
  }
  return true;
}

export { NOT_DOCUMENTED };
