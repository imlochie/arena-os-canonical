// ============================================================================
// Lochie Life College — bootstrap (SERVER ONLY)
// ============================================================================
// Seeds ONLY what is directly supported by fetched institutional sources.
//
// Deliberately NOT seeded, because the sources conflict or do not say:
//   • The Semester I course catalogue beyond PSY110 (Degree Map, Theme Matrix,
//     Schools and Timetable Integration disagree; unresolved).
//   • Timetable day/time mapping (no single authoritative slot table was
//     verified). The College reports UNKNOWN rather than inventing a schedule.
//   • Any student goals, learning history, or teaching memory. Those are the
//     student's to declare; fabricating them would corrupt the record.
//
// Idempotent: safe to run repeatedly.
// ============================================================================

import { db } from "@/db";
import {
  collegeCapabilities,
  collegeCourses,
  collegeFaculty,
  collegeInstitution,
  collegeSources,
  collegeTerms,
  collegeWeeks,
} from "@/db/college";
import { eq, sql } from "drizzle-orm";
import { FACULTY_POSITIONS } from "./faculty";

const N = "https://heady-glade-e3f.notion.site";

/** Institutional sources verified by direct fetch during this build. */
const SOURCES = [
  {
    key: "prospectus_handbook",
    title: "The Lochie Life College Prospectus & Academic Handbook — First Edition",
    url: `${N}/The-Lochie-Life-College-Prospectus-Academic-Handbook-First-Edition-2b6a5556662b4893b651fa0a1ee8e364`,
    authorityLevel: "governance",
    canonicalStatus: "canonical",
    owner: "Administration (via formal amendment)",
    notes:
      "Constitutional governance and academic policy, Version 1.0 baseline. Change control: amend only via the Editorial Amendment Register.",
  },
  {
    key: "academic_calendar",
    title: "Academic Calendar (Source of Truth)",
    url: `${N}/Academic-Calendar-Source-of-Truth-8e6dac8ab8b5404eb6deefd320bd0600`,
    authorityLevel: "academic_standard",
    canonicalStatus: "canonical",
    owner: "Administration",
    notes:
      "Institutional infrastructure. All dates and academic weeks derive from here, not from memory. Semester I Week 1 Monday = 6 Jul 2026; ten weeks listed.",
  },
  {
    key: "institutional_state",
    title: "Institutional State — Current (Pick up anywhere)",
    url: `${N}/Institutional-State-Current-Pick-up-anywhere-913c711a2bbe4749972a7dbd69cbf167`,
    authorityLevel: "operational",
    canonicalStatus: "validated",
    owner: "Administration",
    notes:
      "Declares Semester I Week 1 (Observation), Monday & Wednesday filed, Faculty status Ready. Conflicts with the calendar as of 20 Sep 2026.",
  },
  {
    key: "faculty_teaching_standard",
    title: "Faculty Teaching Standard (Version 1.0)",
    url: `${N}/Faculty-Teaching-Standard-Version-1-0-e677c5ed6b7e433bb00634ac5b53656e`,
    authorityLevel: "academic_standard",
    canonicalStatus: "canonical",
    owner: "Academic governance",
    notes: "Listed in Appendix A as a canonical document.",
  },
  {
    key: "information_flow_protocol",
    title: "Information Flow Protocol (Faculty ↔ Administration)",
    url: `${N}/Information-Flow-Protocol-Faculty-Administration-3241dafc78774aa8b99e9d35781007f9`,
    authorityLevel: "operational",
    canonicalStatus: "validated",
    owner: "Administration",
    notes:
      "Faculty owns academic continuity and handoff preparation; Administration owns classification, filing and records.",
  },
  {
    key: "academic_course_design_standards",
    title: "Academic Course Design Standards",
    url: `${N}/The-Lochie-Life-College-Prospectus-Academic-Handbook-First-Edition-2b6a5556662b4893b651fa0a1ee8e364`,
    authorityLevel: "academic_standard",
    canonicalStatus: "canonical",
    owner: "Academic governance",
    notes:
      "Blueprint → 10-week roadmap → lessons. Assessments are authentic projects, no exams.",
  },
  {
    key: "psy110_blueprint",
    title: "PSY110 — Personal Systems (Course Blueprint)",
    url: `${N}/PSY110-Personal-Systems-Course-Blueprint-d578982031664e84925381ad8db1a197`,
    authorityLevel: "academic_standard",
    canonicalStatus: "validated",
    owner: "Faculty",
    notes:
      "The only course linked from the catalogue section. Catalogue states no courses approved in the First Edition.",
  },
  {
    key: "editorial_amendment_register",
    title: "Editorial Amendment Register (First Edition)",
    url: `${N}/Editorial-Amendment-Register-First-Edition-82f36e1623504e538a694d79ca80a4d9`,
    authorityLevel: "governance",
    canonicalStatus: "canonical",
    owner: "Administration",
    notes: "Canonical amendment control.",
  },
  {
    key: "teaching_session_lifecycle",
    title: "Teaching Session Lifecycle Standard",
    url: `${N}/Institutional-State-Current-Pick-up-anywhere-913c711a2bbe4749972a7dbd69cbf167`,
    authorityLevel: "draft",
    canonicalStatus: "draft",
    owner: "Faculty",
    notes:
      "Filed as DRAFT with amendment proposal entered. Not in force — the runtime must not treat it as ratified.",
  },
  {
    key: "faculty_ai_instructions",
    title: "Faculty AI Operating Instructions (supplied by founder)",
    url: "",
    authorityLevel: "operational",
    canonicalStatus: "unverified",
    owner: "Founder",
    notes:
      "Behavioural instructions for AI acting as Faculty. Authority status not yet confirmed: filed guidance, current prompt, or draft. Treated as evidence of intended behaviour, not constitutional canon.",
  },
  {
    key: "build_brief",
    title: "Institutional Runtime Build Brief (founder)",
    url: "",
    authorityLevel: "working",
    canonicalStatus: "unverified",
    owner: "Founder",
    notes: "The instruction that produced this runtime. Design input, not institutional canon.",
  },
] as const;

/** Core graduate capabilities — verbatim from the handbook, Part II §3. */
const CAPABILITIES = [
  "Critical Thinking",
  "Self-Leadership",
  "Communication",
  "Creativity",
  "Systems Thinking",
  "Health & Wellbeing",
  "Financial Capability",
  "Practical Living",
  "Relationships",
  "Adventure & Exploration",
  "Digital Literacy",
  "Reflection & Adaptability",
];

/** Semester I week table — verbatim from the Academic Calendar. */
const WEEKS: Array<[number, string, string]> = [
  [1, "2026-07-06", "Observation"],
  [2, "2026-07-13", "Patterns"],
  [3, "2026-07-20", "Friction"],
  [4, "2026-07-27", "Design"],
  [5, "2026-08-03", "Rhythm"],
  [6, "2026-08-10", "Attention"],
  [7, "2026-08-17", "Feedback"],
  [8, "2026-08-24", "Recovery"],
  [9, "2026-08-31", "Alignment"],
  [10, "2026-09-07", "Integration"],
];

export interface BootstrapResult {
  created: string[];
  skipped: string[];
  notes: string[];
}

export async function bootstrapCollege(): Promise<BootstrapResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  // ---- sources ----
  for (const s of SOURCES) {
    const existing = await db
      .select()
      .from(collegeSources)
      .where(eq(collegeSources.key, s.key))
      .limit(1);
    if (existing.length) {
      skipped.push(`source:${s.key}`);
      continue;
    }
    await db.insert(collegeSources).values({
      key: s.key,
      title: s.title,
      url: s.url,
      authorityLevel: s.authorityLevel,
      canonicalStatus: s.canonicalStatus,
      owner: s.owner,
      notes: s.notes,
    });
    created.push(`source:${s.key}`);
  }

  // ---- institution ----
  const instRows = await db.select().from(collegeInstitution).limit(1);
  if (!instRows.length) {
    await db.insert(collegeInstitution).values({
      name: "Lochie Life College",
      motto: "Become by Learning.",
      foundingQuote: "That's Life.",
      timezone: "Australia/Brisbane",
      academicYear: 2026,
      institutionalPhase: "Semester I — Foundations (Version 1.0 baseline)",
      declaredTermKey: "semester-i-2026",
      declaredWeekIndex: 1,
      declaredWeekTheme: "Observation",
      declaredStatusNote:
        "Institutional State declares Semester I • Week 1 in progress (Monday & Wednesday filed).",
      declaredSourceKey: "institutional_state",
      declaredObservedAt: new Date(),
      facultyStatus: "Ready",
    });
    created.push("institution");
    notes.push(
      "Declared position recorded as Week 1 per Institutional State. This is stored as a declaration, not as truth — the state engine compares it against the calendar and will report a CONFLICT."
    );
  } else {
    skipped.push("institution");
  }

  // ---- term + weeks ----
  const termRows = await db
    .select()
    .from(collegeTerms)
    .where(eq(collegeTerms.key, "semester-i-2026"))
    .limit(1);
  let termId: string;
  if (!termRows.length) {
    const [t] = await db
      .insert(collegeTerms)
      .values({
        key: "semester-i-2026",
        name: "Semester I — 2026 (Foundations)",
        year: 2026,
        startMonday: "2026-07-06",
        weekCount: 10,
        status: "active",
        sourceKey: "academic_calendar",
      })
      .returning();
    termId = t.id;
    created.push("term:semester-i-2026");
  } else {
    termId = termRows[0].id;
    skipped.push("term:semester-i-2026");
  }

  const existingWeeks = await db.select().from(collegeWeeks).where(eq(collegeWeeks.termId, termId));
  if (!existingWeeks.length) {
    for (const [idx, monday, theme] of WEEKS) {
      await db.insert(collegeWeeks).values({
        termId,
        weekIndex: idx,
        mondayDate: monday,
        theme,
        // The calendar's own status column is unticked for every week.
        // Institutional State separately says Week 1 was delivered and filed.
        status: idx === 1 ? "delivered" : "not_started",
        evidenceNote:
          idx === 1
            ? "Institutional State records Week 1 Monday & Wednesday as filed. The Academic Calendar's evidence column is empty."
            : "",
        sourceKey: "academic_calendar",
      });
    }
    created.push(`weeks:1-10`);
    notes.push(
      "Week 1 marked delivered on the authority of Institutional State; the Academic Calendar itself records no evidence links. Weeks 2–10 remain not_started — the College does not assume delivery."
    );
  } else {
    skipped.push("weeks");
  }

  // ---- capabilities ----
  const capRows = await db.select().from(collegeCapabilities).limit(1);
  if (!capRows.length) {
    for (const name of CAPABILITIES) {
      await db.insert(collegeCapabilities).values({
        key: name.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""),
        name,
        sourceKey: "prospectus_handbook",
      });
    }
    created.push(`capabilities:${CAPABILITIES.length}`);
  } else {
    skipped.push("capabilities");
  }

  // ---- PSY110 only ----
  const courseRows = await db
    .select()
    .from(collegeCourses)
    .where(eq(collegeCourses.code, "PSY110"))
    .limit(1);
  if (!courseRows.length) {
    await db.insert(collegeCourses).values({
      code: "PSY110",
      title: "Personal Systems",
      schoolKey: "",
      level: 100,
      courseType: "core",
      // Catalogue policy: "No courses have been approved yet in the First Edition."
      status: "blueprint",
      summary:
        "Course Blueprint linked from the handbook catalogue section. Teaching activity is recorded for Semester I Week 1.",
      sourceKey: "psy110_blueprint",
      notes:
        "Handbook states no courses are approved in the First Edition, yet teaching has been delivered and filed against PSY110. Status held as 'blueprint' rather than silently upgraded to 'approved'.",
    });
    created.push("course:PSY110");
    notes.push(
      "PSY110 recorded as blueprint, not approved — the catalogue explicitly says no courses are approved in the First Edition. This tension is surfaced rather than resolved."
    );
  } else {
    skipped.push("course:PSY110");
  }

  // ---- faculty positions ----
  const facRows = await db.select().from(collegeFaculty).limit(1);
  if (!facRows.length) {
    for (const p of FACULTY_POSITIONS) {
      await db.insert(collegeFaculty).values({
        positionKey: p.key,
        name: p.name,
        remit: p.remit,
        authorityBoundary: p.authorityBoundary,
        mayFileRecords: p.mayFileRecords,
        mayAssess: p.mayAssess,
        outputType: p.outputType,
        workforceRoleId: p.workforceRoleId,
        contextScope: JSON.stringify(p.contextScope),
        derivation: p.derivation,
        sourceKey: p.sourceKey,
      });
    }
    created.push(`faculty:${FACULTY_POSITIONS.length}`);
    notes.push(
      "No faculty position may file records or issue formal assessments. The Registrar proposes; filing remains an explicit institutional act."
    );
  } else {
    skipped.push("faculty");
  }

  notes.push(
    "Timetable slots deliberately NOT seeded: no single authoritative day/time mapping was verified, and the Degree Map, Theme Matrix, Schools and Timetable Integration pages disagree. The College reports the timetable as UNKNOWN rather than inventing one."
  );

  return { created, skipped, notes };
}
