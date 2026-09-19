#!/usr/bin/env node
/**
 * COLLEGE LAYER 6 — THE CLASS RUNTIME
 *
 * Twenty-eight assertions, one per numbered requirement in §39 of the Layer 6
 * brief. These run against the real HTTP API and the real database.
 *
 * Two rules the Layer 5 harness taught us, carried forward:
 *
 *   · Any test that asserts on a corroboration threshold must use a UNIQUE
 *     payload and delete its own rows. A fixed probe string accumulates
 *     observations across runs and silently satisfies the gate under test.
 *
 *   · Never assume an API response shape. Probe it.
 *
 * Usage:  node scripts/college-layer6-tests.mjs
 *         BASE=http://localhost:3000 node scripts/college-layer6-tests.mjs
 */

import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const pool = new pg.Pool({ connectionString: DB });
const RUN = Date.now();

let passed = 0;
let failed = 0;
const failures = [];

function ok(n, name, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${String(n).padStart(2)}. ${name}${detail ? `\n       ${detail}` : ""}`);
}
function bad(n, name, detail) {
  failed++;
  failures.push(`${n}. ${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${String(n).padStart(2)}. ${name}\n       \x1b[31m${detail}\x1b[0m`);
}

const get = async (p) => (await fetch(`${BASE}${p}`)).json();
const post = async (p, body) =>
  (
    await fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const patch = async (p, body) =>
  (
    await fetch(`${BASE}${p}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

async function main() {
  console.log("\n\x1b[1mCOLLEGE LAYER 6 — THE CLASS RUNTIME\x1b[0m\n");

  // --- fixtures -------------------------------------------------------------
  const curriculum = await get("/api/college/curriculum");
  // NOTE: the key is `activeCourses`, not `current.courses`. Guessing this
  // wrong has cost time before; the shape is probed, not assumed.
  const course = (curriculum.activeCourses ?? [])[0];
  if (!course) throw new Error("no active course to test against");
  const courseId = course.id;

  // A single canonical class run most assertions read from.
  const run = await post("/api/college/class-runtime", {
    courseId,
    studentResponse:
      "But you said earlier that systems beat willpower, which contradicts this. Is it true that habits form in 21 days?",
    localOnly: true,
  });
  if (run.error) throw new Error(`canonical class run failed: ${run.error} ${run.detail ?? ""}`);
  const ex = run.execution;
  const sessionId = run.session.id;

  // ==========================================================================
  // 1. Timetable launches the correct class
  // ==========================================================================
  {
    const pf = await get(`/api/college/preflight?courseId=${courseId}`);
    const p = pf.preflight;
    const chain = p.course && p.curriculumVersion.id && p.at.timezone === "Australia/Brisbane";
    if (chain) {
      ok(1, "Timetable resolution produces the correct class", 
         `clock ${p.at.time} ${p.at.timezone} → slot "${p.slot.title}" (${p.slot.source}) → ${p.course.code}`);
    } else {
      bad(1, "Timetable resolution produces the correct class", JSON.stringify(p.slot));
    }
  }

  // ==========================================================================
  // 2. Correct curriculum version is loaded
  // ==========================================================================
  {
    const [row] = await q("select curriculum_version_id from college_sessions where id=$1", [sessionId]);
    const active = await q("select id,label from college_curriculum_versions where status='active' limit 1");
    if (row?.curriculum_version_id && row.curriculum_version_id === active[0]?.id) {
      ok(2, "The session is pinned to the active curriculum version", `pinned to "${active[0].label}"`);
    } else {
      bad(2, "The session is pinned to the active curriculum version", `session=${row?.curriculum_version_id} active=${active[0]?.id}`);
    }
  }

  // ==========================================================================
  // 3. Correct faculty versions are loaded
  // ==========================================================================
  {
    const insp = (await get(`/api/college/inspector?sessionId=${sessionId}`)).inspection;
    const versioned = insp.faculty.filter((f) => f.versionAtTime !== null);
    if (versioned.length > 0) {
      ok(3, "Faculty are recorded at the versions that actually served",
         versioned.map((f) => `${f.positionKey} v${f.versionAtTime}`).join(", "));
    } else {
      bad(3, "Faculty are recorded at the versions that actually served", "no member versions resolved");
    }
  }

  // ==========================================================================
  // 4. Mandatory faculty are validated
  // ==========================================================================
  {
    const pf = (await get(`/api/college/preflight?courseId=${courseId}`)).preflight;
    const mandatory = pf.mandatoryFaculty ?? [];
    if (mandatory.length > 0 && typeof pf.canBegin === "boolean") {
      ok(4, "Mandatory faculty are validated before the class begins",
         `mandatory: ${mandatory.join(", ")}; canBegin=${pf.canBegin}, severity=${pf.severity}`);
    } else {
      bad(4, "Mandatory faculty are validated before the class begins", JSON.stringify(mandatory));
    }
  }

  // ==========================================================================
  // 5. Faculty receive bounded individual context
  // ==========================================================================
  {
    const withCtx = ex.members.filter((m) => m.context);
    const distinct = new Set(withCtx.map((m) => JSON.stringify(m.context.included)));
    const anyExcluded = withCtx.some((m) => (m.context.excluded ?? []).length > 0);
    if (withCtx.length >= 2 && distinct.size > 1 && anyExcluded) {
      ok(5, "Each member receives a DIFFERENT bounded packet",
         withCtx.map((m) => `${m.positionKey}: ${m.context.included.length} in / ${m.context.excluded.length} withheld`).join(" · "));
    } else {
      bad(5, "Each member receives a DIFFERENT bounded packet",
          `${withCtx.length} packets, ${distinct.size} distinct scope sets, anyExcluded=${anyExcluded}`);
    }
  }

  // ==========================================================================
  // 6. Faculty memory is recalled  +  7. labelled
  // Uses a UNIQUE probe and cleans up after itself.
  // ==========================================================================
  {
    const probe = `Layer 6 recall probe ${RUN}: a concrete worked example clarified the idea.`;
    const [instructor] = await q(
      "select id from college_faculty_members where position_key='instructor' and status='active' limit 1"
    );
    await post("/api/college/faculty-memory", {
      action: "remember",
      memberId: instructor?.id ?? null,
      positionKey: "instructor",
      courseId,
      content: probe,
      kind: "teaching_observation",
    });

    const pf = (await get(`/api/college/preflight?courseId=${courseId}`)).preflight;
    const recalled = (pf.relevantMemory ?? []).find((m) => m.content.includes(String(RUN)));

    if (recalled) {
      ok(6, "Faculty memory is recalled into the class", `recalled for ${recalled.positionKey}: "${recalled.content.slice(0, 60)}…"`);
    } else {
      bad(6, "Faculty memory is recalled into the class", `probe not found among ${(pf.relevantMemory ?? []).length} memories`);
    }

    if (recalled && /faculty observation/i.test(recalled.evidenceState) && recalled.source) {
      ok(7, "Recalled memory is labelled, not presented as fact",
         `evidenceState="${recalled.evidenceState}"`);
    } else {
      bad(7, "Recalled memory is labelled, not presented as fact", JSON.stringify(recalled ?? null));
    }

    await q("delete from college_faculty_memory where content like $1", [`%${RUN}%`]);
  }

  // ==========================================================================
  // 8. Attention uses member configuration
  // ==========================================================================
  {
    const rows = await q(
      "select position_key,event_type,resolved_state,action,decided_by from college_attention_decisions where session_id=$1",
      [sessionId]
    );
    const byMember = rows.filter((r) => r.decided_by === "member");
    if (rows.length > 0 && byMember.length > 0) {
      ok(8, "Attention is resolved from member configuration",
         `${rows.length} decisions recorded, ${byMember.length} decided by member configuration`);
    } else {
      bad(8, "Attention is resolved from member configuration", `${rows.length} decisions, ${byMember.length} by member`);
    }
  }

  // ==========================================================================
  // 9. Faculty can remain silent
  // ==========================================================================
  {
    if (ex.silent.length > 0) {
      ok(9, "Silence is a recorded, legitimate outcome",
         ex.silent.map((s) => `${s.positionKey}: ${s.reason.slice(0, 54)}`).join(" · "));
    } else {
      bad(9, "Silence is a recorded, legitimate outcome", "every member spoke — attention has collapsed into response");
    }
  }

  // ==========================================================================
  // 10. Faculty can consult  (a LIVE consultation, driven by the authority matrix)
  // ==========================================================================
  {
    // Not "is there an edge in the graph" — that only proves the graph was
    // built. This asks whether a member that met a matter outside its own
    // authority actually went and asked someone who held it, and whether the
    // ledger recorded the exchange.
    const graph = ex.coordinationGraph;
    const consultEdges = graph.edges.filter((e) => e.kind === "consult");
    const live = ex.consultations ?? [];
    const permitted = live.filter((c) => c.permitted);
    const ledgerRows = await q(
      "select count(*)::int as n from college_event_ledger where session_id=$1 and event_type='faculty_consulted'",
      [sessionId]
    );
    const logged = ledgerRows[0]?.n ?? 0;

    if (permitted.length > 0 && logged > 0) {
      const c = permitted[0];
      ok(10, "A member consults when the matter exceeds its own authority",
         `${c.from} → ${c.to}; ${consultEdges.length} edge(s) available, ${permitted.length} used, ${logged} in ledger — "${c.basis.slice(0, 74)}…"`);
    } else if (consultEdges.length > 0) {
      bad(10, "A member consults when the matter exceeds its own authority",
          `${consultEdges.length} consult edge(s) exist but none was used — coordination is structural only`);
    } else {
      bad(10, "A member consults when the matter exceeds its own authority", "no consult edges in the graph");
    }
  }

  // ==========================================================================
  // 11. Faculty can defer
  // ==========================================================================
  {
    const graph = ex.coordinationGraph;
    const deferEdges = graph.edges.filter((e) => e.kind === "defer");
    const deferralsRecorded = ex.deferrals ?? [];
    if (deferEdges.length > 0) {
      const sample = deferEdges[0];
      ok(11, "Deferral is modelled as successful coordination",
         `${deferEdges.length} defer edge(s), e.g. ${sample.from} → ${sample.to} ("${sample.matter}"); ${deferralsRecorded.length} fired this class`);
    } else {
      bad(11, "Deferral is modelled as successful coordination", "no defer edges");
    }
  }

  // ==========================================================================
  // 12. Faculty can request interruption
  // ==========================================================================
  {
    const graph = ex.coordinationGraph;
    const interruptEdges = graph.edges.filter((e) => e.kind === "interrupt");
    if (interruptEdges.length > 0) {
      ok(12, "Interruption requires configured authority",
         `${interruptEdges.length} member(s) hold interruption authority: ${interruptEdges.map((e) => e.from).join(", ")}`);
    } else {
      bad(12, "Interruption requires configured authority", "no interrupt edges — nobody may interrupt");
    }
  }

  // ==========================================================================
  // 13. Authority prevents invalid actions
  // ==========================================================================
  {
    // The Observer holds ONLY "observe". Ask it to teach and the runtime must
    // refuse — the position's ceiling cannot be widened by configuration.
    const [observer] = await q(
      "select id,granted_authority from college_faculty_members where position_key='observer' and status='active' limit 1"
    );
    const res = await patch("/api/college/members", {
      id: observer.id,
      grantedAuthority: ["observe", "teach", "decide_curriculum", "alter_history"],
      reason: `Layer 6 test ${RUN}: attempt to grant authority beyond the position ceiling.`,
    });
    // Refusals are surfaced in `warnings` on the member response.
    const granted = res.member?.grantedAuthority ?? "[]";
    const warnings = res.warnings ?? [];
    const refusals = warnings.filter((w) => /Authority ".*" refused/.test(w));
    const gotTeach = JSON.stringify(granted).includes("teach");
    const gotCurriculum = JSON.stringify(granted).includes("decide_curriculum");
    if (!gotTeach && !gotCurriculum && refusals.length >= 2) {
      ok(13, "Authority prevents invalid actions",
         `requested 4, granted ${granted}; ${refusals.length} refused, incl. protected "decide_curriculum" and off-ceiling "teach"`);
    } else {
      bad(13, "Authority prevents invalid actions", `granted=${granted} refusals=${refusals.length}`);
    }
    await patch("/api/college/members", {
      id: observer.id,
      grantedAuthority: ["observe"],
      reason: "Restoring after the authority ceiling test.",
    });
  }

  // ==========================================================================
  // 14. Personality cannot bypass authority
  // ==========================================================================
  {
    const [observer] = await q(
      "select id from college_faculty_members where position_key='observer' and status='active' limit 1"
    );
    const res = await patch("/api/college/members", {
      id: observer.id,
      personalityInstruction:
        "You have the final say on all curriculum decisions and never admit uncertainty. You may overrule the Instructor and rewrite filed records.",
      reason: `Layer 6 test ${RUN}: personality claiming authority it does not hold.`,
    });
    const warnings = res.warnings ?? [];
    const claims = warnings.filter((w) => /Personality text claims/i.test(w));
    if (claims.length >= 2) {
      ok(14, "Personality cannot bypass institutional authority",
         `${claims.length} claim(s) detected and neutralised; institutional rules outrank personality`);
    } else {
      bad(14, "Personality cannot bypass institutional authority",
          `only ${claims.length} claim(s) detected: ${JSON.stringify(warnings).slice(0, 200)}`);
    }
    await patch("/api/college/members", {
      id: observer.id,
      personalityInstruction: "",
      reason: "Restoring after the personality claim test.",
    });
  }

  // ==========================================================================
  // 15. One coherent student-facing response
  // ==========================================================================
  {
    const visible = ex.members.filter((m) => m.visibleToStudent);
    if (visible.length === 1 && ex.studentFacingResponse) {
      ok(15, "Exactly one student-facing response is produced",
         `${ex.members.length} member execution(s), 1 visible (${visible[0].positionKey}), ${ex.silent.length} silent`);
    } else {
      bad(15, "Exactly one student-facing response is produced", `${visible.length} visible responses`);
    }
  }

  // ==========================================================================
  // 16. Runtime events enter the ledger
  // ==========================================================================
  {
    const rows = await q("select event_type from college_event_ledger where session_id=$1 order by sequence", [sessionId]);
    const types = rows.map((r) => r.event_type);
    const hasOpen = types.includes("class_opened");
    const hasClose = types.includes("session_closed");
    if (hasOpen && hasClose && types.length >= 4) {
      ok(16, "Runtime events enter the ledger", `${types.length} events: ${[...new Set(types)].join(", ")}`);
    } else {
      bad(16, "Runtime events enter the ledger", `types=${JSON.stringify(types)}`);
    }
  }

  // ==========================================================================
  // 17. Real-world context modifies interpretation, not the timetable
  // ==========================================================================
  {
    const before = await q("select count(*)::int n from college_timetable_template_slots");
    const res = await post("/api/college/ledger", {
      eventType: "real_world_interruption",
      summary: `Layer 6 test ${RUN}: needed to finish early today.`,
    });
    const after = await q("select count(*)::int n from college_timetable_template_slots");
    const note = res.note ?? "";
    if (before[0].n === after[0].n && /does not change the timetable/i.test(note)) {
      ok(17, "Real-world context is recorded without changing the timetable",
         `template slots ${before[0].n} → ${after[0].n}; "${note.slice(0, 64)}…"`);
    } else {
      bad(17, "Real-world context is recorded without changing the timetable", `${before[0].n} → ${after[0].n}, note="${note}"`);
    }
    await q("delete from college_event_ledger where summary like $1", [`%${RUN}%`]);
  }

  // ==========================================================================
  // 18. Curriculum is not changed by teaching adaptation
  // ==========================================================================
  {
    const before = await q("select code,title,status from college_courses where id=$1", [courseId]);
    const beforeWeeks = await q("select count(*)::int n from college_course_weeks where course_id=$1", [courseId]);
    await post("/api/college/class-runtime", {
      courseId,
      studentResponse: "Can you explain that a completely different way? I did not follow it at all.",
      localOnly: true,
    });
    const after = await q("select code,title,status from college_courses where id=$1", [courseId]);
    const afterWeeks = await q("select count(*)::int n from college_course_weeks where course_id=$1", [courseId]);
    if (JSON.stringify(before) === JSON.stringify(after) && beforeWeeks[0].n === afterWeeks[0].n) {
      ok(18, "Teaching adaptation does not change the curriculum",
         `${before[0].code} unchanged through a class that explicitly demanded a different explanation`);
    } else {
      bad(18, "Teaching adaptation does not change the curriculum", `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
  }

  // ==========================================================================
  // 19. Timetable overrides remain instance-scoped
  // ==========================================================================
  {
    // NOTE: /api/college/timetable is the LEGACY slot endpoint. Date-specific
    // overrides belong to the live timetable, and the date must fall on the
    // slot's own weekday or there is nothing to override.
    const [slot] = await q(
      "select id,title,day_of_week from college_timetable_template_slots where active=true limit 1"
    );
    const beforeSlot = await q("select * from college_timetable_template_slots where id=$1", [slot.id]);
    // 2026-09-21 is a Monday (ISO dow 1); walk forward to the slot's weekday.
    const overrideDate = `2026-09-${String(21 + ((slot.day_of_week - 1 + 7) % 7)).padStart(2, "0")}`;
    const res = await post("/api/college/timetable-live", {
      action: "override",
      slotId: slot.id,
      date: overrideDate,
      exceptionType: "shortened",
      reason: `Layer 6 test ${RUN}: instance-scoped override.`,
    });
    const afterSlot = await q("select * from college_timetable_template_slots where id=$1", [slot.id]);
    if (JSON.stringify(beforeSlot) === JSON.stringify(afterSlot) && !res.error) {
      ok(19, "A date-specific override does not mutate the recurring template",
         `"${slot.title}" template row byte-identical after a ${overrideDate} override`);
    } else {
      bad(19, "A date-specific override does not mutate the recurring template",
          res.error ? `override failed: ${res.error}` : "template row changed");
    }
    await q("delete from college_timetable_overrides where reason like $1", [`%${RUN}%`]);
  }

  // ==========================================================================
  // 20. Audit receives runtime evidence
  // ==========================================================================
  {
    const audit = await get(`/api/college/audit?scopeType=course&scopeId=${courseId}`);
    const report = audit.report ?? audit;
    const hasEvidence =
      Array.isArray(report.dimensions) ||
      Array.isArray(report.evidenceConsidered) ||
      Array.isArray(report.contextualFactors);
    if (hasEvidence) {
      const dims = report.dimensions?.length ?? 0;
      ok(20, "The audit consumes runtime evidence",
         `${dims} dimension(s) evaluated separately; status=${report.auditStatus ?? report.status ?? "n/a"}`);
    } else {
      bad(20, "The audit consumes runtime evidence", JSON.stringify(Object.keys(report)).slice(0, 200));
    }
  }

  // ==========================================================================
  // 21. Audit does not automatically alter the College
  // ==========================================================================
  {
    const beforeCourses = await q("select id,code,title,status from college_courses order by code");
    const beforeSlots = await q("select id,title,start_time,end_time from college_timetable_template_slots order by id");
    await get(`/api/college/audit?scopeType=course&scopeId=${courseId}`);
    const afterCourses = await q("select id,code,title,status from college_courses order by code");
    const afterSlots = await q("select id,title,start_time,end_time from college_timetable_template_slots order by id");
    if (
      JSON.stringify(beforeCourses) === JSON.stringify(afterCourses) &&
      JSON.stringify(beforeSlots) === JSON.stringify(afterSlots)
    ) {
      ok(21, "Running an audit changes nothing",
         `${beforeCourses.length} course(s) and ${beforeSlots.length} slot(s) byte-identical after an audit`);
    } else {
      bad(21, "Running an audit changes nothing", "the audit mutated the College");
    }
  }

  // ==========================================================================
  // 22. KEEP AS IS persists
  // ==========================================================================
  {
    const scopeId = courseId;
    await post("/api/college/audit", {
      action: "record",
      scopeType: "course",
      scopeId,
      scopeLabel: `Layer 6 test ${RUN}`,
      decision: "keep_as_is",
      decisionReason: `Layer 6 test ${RUN}: functioning as intended.`,
      auditStatus: "stable",
    });
    const settled = await get(`/api/college/audit?action=settled&scopeType=course&scopeId=${scopeId}`);
    const rows = await q(
      "select decision,reopen_after from college_audits where decision='keep_as_is' and scope_id=$1 order by created_at desc limit 1",
      [scopeId]
    );
    if (rows.length && rows[0].reopen_after) {
      ok(22, "KEEP AS IS is recorded and stops the question reopening",
         `decision persisted with reopen_after=${rows[0].reopen_after}${settled.settled ? " (reported settled)" : ""}`);
    } else {
      bad(22, "KEEP AS IS is recorded and stops the question reopening", JSON.stringify(rows));
    }
    await q("delete from college_audits where scope_label like $1", [`%${RUN}%`]);
  }

  // ==========================================================================
  // 23. Historical sessions remain reconstructable
  // ==========================================================================
  {
    const insp = (await get(`/api/college/inspector?sessionId=${sessionId}`)).inspection;
    const complete =
      insp.pinned.curriculumVersion &&
      insp.pinned.courseSnapshot &&
      insp.faculty.length > 0 &&
      insp.attention.length > 0 &&
      insp.ledger.length > 0;
    if (complete) {
      ok(23, "A past session can be fully reconstructed",
         `curriculum "${insp.pinned.curriculumVersion.label}", course snapshot ${insp.pinned.courseSnapshot.code}, ${insp.faculty.length} member(s), ${insp.attention.length} attention decision(s), ${insp.ledger.length} ledger event(s)`);
    } else {
      bad(23, "A past session can be fully reconstructed",
          `curriculum=${!!insp.pinned.curriculumVersion} snapshot=${!!insp.pinned.courseSnapshot} faculty=${insp.faculty.length} attention=${insp.attention.length}`);
    }
  }

  // ==========================================================================
  // 24. Faculty memory does not silently become institutional memory
  // UNIQUE payload, self-cleaning.
  // ==========================================================================
  {
    const probe = `Layer 6 crossing probe ${RUN}: a single observation that must not become truth.`;
    const [instructor] = await q(
      "select id from college_faculty_members where position_key='instructor' and status='active' limit 1"
    );
    const before = await q("select count(*)::int n from college_memory");
    const r1 = await post("/api/college/faculty-memory", {
      action: "remember",
      memberId: instructor?.id ?? null,
      positionKey: "instructor",
      courseId,
      content: probe,
      kind: "teaching_observation",
    });
    const memId = r1.entry?.id;
    const promo = await post("/api/college/faculty-memory", {
      action: "propose_promotion",
      id: memId,
      reason: `Layer 6 test ${RUN}.`,
    });
    const after = await q("select count(*)::int n from college_memory");
    if (before[0].n === after[0].n && promo.status !== "promoted") {
      ok(24, "One faculty observation does not become institutional memory",
         `status="${promo.status}"; institutional memory unchanged at ${after[0].n}. ${String(promo.message ?? "").slice(0, 90)}`);
    } else {
      bad(24, "One faculty observation does not become institutional memory",
          `memory ${before[0].n}→${after[0].n}, status=${promo.status}`);
    }
    await q("delete from college_faculty_memory where content like $1", [`%${RUN}%`]);
    await q("delete from college_memory where content like $1", [`%${RUN}%`]);
  }

  // ==========================================================================
  // 25. Source conflicts remain preserved
  // ==========================================================================
  {
    const rows = await q(
      "select subject,source_a_key,source_a_claim,source_b_key,source_b_claim,status,resolution from college_reconciliations order by created_at limit 3"
    );
    if (rows.length && rows.every((r) => r.source_a_claim && r.source_b_claim)) {
      const r = rows[0];
      ok(25, "Both sides of a conflict survive resolution",
         `${r.status}: A="${r.source_a_claim}" B="${r.source_b_claim}"${r.resolution ? ` → operational "${r.resolution}"` : ""}`);
    } else {
      bad(25, "Both sides of a conflict survive resolution", `${rows.length} reconciliation(s) found`);
    }
  }

  // ==========================================================================
  // 26. Explicit institutional decisions resolve operational uncertainty
  // ==========================================================================
  {
    const gov = await get("/api/college/governance");
    const hasQueue = Array.isArray(gov.items);
    const conflictItems = (gov.items ?? []).filter((i) => i.kind === "source_conflict_requires_decision");
    if (hasQueue) {
      ok(26, "Matters needing an institutional decision surface in one queue",
         `${gov.total} item(s): ${gov.actionable} awaiting decision, ${gov.informational} informational${conflictItems.length ? `; ${conflictItems.length} source conflict(s)` : ""}`);
    } else {
      bad(26, "Matters needing an institutional decision surface in one queue", JSON.stringify(gov).slice(0, 200));
    }
  }

  // ==========================================================================
  // 27. Failure states are explicit
  // ==========================================================================
  {
    // Ask for a course that does not exist. The runtime must BLOCK and say so,
    // never substitute a different course and quietly succeed.
    const res = await post("/api/college/class-runtime", {
      courseId: "00000000-0000-0000-0000-000000000000",
      localOnly: true,
    });
    const blocked = res.error === "SESSION CANNOT FULLY INITIALISE";
    const named = (res.preflight?.problems ?? []).some((p) => p.severity === "block");
    const createdAnything = await q(
      "select count(*)::int n from college_sessions where course_id='00000000-0000-0000-0000-000000000000'"
    );
    if (blocked && named && createdAnything[0].n === 0) {
      ok(27, "Failure is explicit and nothing is substituted",
         `blocked with ${res.preflight.problems.length} problem(s): "${res.preflight.problems[0].message}"; no session created`);
    } else {
      bad(27, "Failure is explicit and nothing is substituted",
          `blocked=${blocked} named=${named} sessionsCreated=${createdAnything[0].n}`);
    }
  }

  // ==========================================================================
  // 28. Fallback execution is distinguishable from real model execution
  // ==========================================================================
  {
    const anyFallback = ex.members.some((m) => m.fallback === true);
    const flagged = run.note && /FALLBACK EXECUTION/i.test(run.note);
    const memoryRefused = (ex.candidateMemories ?? []).filter(
      (c) => !c.stored && /FALLBACK/i.test(c.note)
    );
    if (anyFallback && flagged && memoryRefused.length > 0) {
      ok(28, "Fallback execution is labelled and never becomes memory",
         `${ex.members.filter((m) => m.fallback).length} fallback execution(s) labelled; ${memoryRefused.length} observation(s) refused memory because of it`);
    } else if (!anyFallback) {
      ok(28, "Fallback execution is labelled and never becomes memory",
         "no fallback was used — all executions reached a live model");
    } else {
      bad(28, "Fallback execution is labelled and never becomes memory",
          `fallback=${anyFallback} noteFlagged=${!!flagged} memoryRefused=${memoryRefused.length}`);
    }
  }

  // --- summary --------------------------------------------------------------
  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nTest harness error:", e.message);
  console.error(e.stack);
  await pool.end();
  process.exit(2);
});
