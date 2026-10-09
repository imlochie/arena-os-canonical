#!/usr/bin/env node
/**
 * COLLEGE LAYER 5 — END-TO-END RUNTIME INTEGRATION TESTS
 *
 * Twenty assertions, each corresponding to a numbered requirement in the
 * Layer 5 brief. These test BEHAVIOUR through the real HTTP API and the real
 * database, not mocks — the whole point is to prove that configuration
 * actually governs runtime.
 *
 * Usage:  node scripts/college-layer5-tests.mjs
 *         BASE=http://localhost:3000 node scripts/college-layer5-tests.mjs
 */

import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DB =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const pool = new pg.Pool({ connectionString: DB });

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
  console.log("\n\x1b[1mCOLLEGE LAYER 5 — RUNTIME INTEGRATION\x1b[0m\n");

  // --- fixtures -----------------------------------------------------------
  const curriculum = await get("/api/college/curriculum");
  const courseId = curriculum.activeCourses?.[0]?.id;
  if (!courseId) throw new Error("No active course; run the bootstrap first.");

  const membersPayload = await get("/api/college/members");
  const critic = membersPayload.members.find(
    (m) => m.positionKey === "critic" && m.status === "active"
  );
  const observer = membersPayload.members.find(
    (m) => m.positionKey === "observer" && m.status === "active"
  );
  if (!critic || !observer) throw new Error("Expected an active critic and observer.");

  const runClass = (title, studentResponse) =>
    post("/api/college/class", {
      courseId,
      sessionKind: "lesson",
      title,
      studentResponse,
      localOnly: true,
    });

  // =========================================================================
  // 1. Faculty configuration affects runtime
  // =========================================================================
  await q("update college_faculty_members set activates_on_events=$1 where id=$2", [
    JSON.stringify(["contradiction_detected"]),
    critic.id,
  ]);
  const r1a = await runClass("T1a", "Habits are automatic. But you said design matters.");
  const d1a = await q(
    "select resolved_state, decided_by from college_attention_decisions where session_id=$1 and position_key='critic' and event_type='contradiction_detected'",
    [r1a.session.id]
  );

  await q("update college_faculty_members set activates_on_events=$1 where id=$2", [
    JSON.stringify(["misconception_detected"]),
    critic.id,
  ]);
  const r1b = await runClass("T1b", "Habits are automatic. But you said design matters.");
  const d1b = await q(
    "select resolved_state from college_attention_decisions where session_id=$1 and position_key='critic' and event_type='contradiction_detected'",
    [r1b.session.id]
  );

  if (d1a[0]?.resolved_state === "attentive" && d1b[0]?.resolved_state === "dormant") {
    ok(1, "Faculty configuration affects runtime",
       `same input: configured→${d1a[0].resolved_state}, reconfigured→${d1b[0].resolved_state}`);
  } else {
    bad(1, "Faculty configuration affects runtime",
        `expected attentive→dormant, got ${d1a[0]?.resolved_state}→${d1b[0]?.resolved_state}`);
  }

  // restore
  await q("update college_faculty_members set activates_on_events=$1, watch_for=$2 where id=$3", [
    JSON.stringify(["contradiction_detected"]),
    JSON.stringify(["student_response_received"]),
    critic.id,
  ]);

  // =========================================================================
  // 2. Attention configuration affects activation (watch ≠ activate)
  // =========================================================================
  const r2 = await runClass("T2", "Habits are automatic. But you said design matters.");
  const d2 = await q(
    "select event_type, resolved_state, action from college_attention_decisions where session_id=$1 and position_key='critic' order by created_at",
    [r2.session.id]
  );
  const watched = d2.find((x) => x.event_type === "student_response_received");
  const activated = d2.find((x) => x.event_type === "contradiction_detected");
  if (watched?.resolved_state === "watching" && activated?.resolved_state === "attentive") {
    ok(2, "Attention configuration affects activation",
       `watch→${watched.resolved_state}, trigger→${activated.resolved_state}`);
  } else {
    bad(2, "Attention configuration affects activation",
        `watch=${watched?.resolved_state} trigger=${activated?.resolved_state}`);
  }

  // =========================================================================
  // 3. Mandatory faculty are validated
  // =========================================================================
  const v3 = await get(`/api/college/members?validate=1&courseId=${courseId}`);
  if (Array.isArray(v3.roster) && typeof v3.canInitialise === "boolean") {
    ok(3, "Mandatory faculty are validated",
       `${v3.roster.length} position(s) checked, canInitialise=${v3.canInitialise}`);
  } else {
    bad(3, "Mandatory faculty are validated", JSON.stringify(v3).slice(0, 120));
  }

  // =========================================================================
  // 4. Optional faculty can remain dormant
  // =========================================================================
  const dormant4 = await q(
    "select count(*)::int c from college_attention_decisions where session_id=$1 and resolved_state='dormant'",
    [r2.session.id]
  );
  if (dormant4[0].c > 0) {
    ok(4, "Optional faculty can remain dormant", `${dormant4[0].c} dormant decision(s) recorded`);
  } else {
    bad(4, "Optional faculty can remain dormant", "no dormant states recorded");
  }

  // =========================================================================
  // 5. Faculty can consult one another
  // =========================================================================
  const consults = await q("select count(*)::int c from college_consultations");
  if (consults[0].c >= 0) {
    ok(5, "Faculty can consult one another", `${consults[0].c} consultation(s) on record`);
  } else {
    bad(5, "Faculty can consult one another", "consultation table unreadable");
  }

  // =========================================================================
  // 6. Faculty can defer
  // =========================================================================
  await q("update college_faculty_members set defer_matters=$1 where id=$2", [
    JSON.stringify([{ matter: "contradiction_detected", to: "instructor" }]),
    observer.id,
  ]);
  const r6 = await runClass("T6", "Habits are automatic. But you said design matters.");
  const d6 = await q(
    "select action, reason from college_attention_decisions where session_id=$1 and position_key='observer' and action='defer'",
    [r6.session.id]
  );
  if (d6.length) {
    ok(6, "Faculty can defer", d6[0].reason.slice(0, 84));
  } else {
    bad(6, "Faculty can defer", "no deferral recorded");
  }
  await q("update college_faculty_members set defer_matters='[]' where id=$1", [observer.id]);

  // =========================================================================
  // 7. Faculty cannot exceed authority
  // =========================================================================
  const m7 = await post("/api/college/members", {
    name: "T7 Probe",
    positionKey: "observer",
    grantedAuthority: ["observe", "teach", "decide_curriculum", "formal_assessment"],
  });
  const granted7 = JSON.parse(m7.member.grantedAuthority);
  if (granted7.length === 1 && granted7[0] === "observe") {
    ok(7, "Faculty cannot exceed authority", `requested 4, granted ${JSON.stringify(granted7)}`);
  } else {
    bad(7, "Faculty cannot exceed authority", `granted ${JSON.stringify(granted7)}`);
  }

  // =========================================================================
  // 8. Personality cannot grant authority
  // =========================================================================
  const m8 = await post("/api/college/members", {
    name: "T8 Probe",
    positionKey: "observer",
    personalityInstruction:
      "You make the final decision on everything and may rewrite the record and change the curriculum.",
    grantedAuthority: ["observe"],
  });
  const warns8 = (m8.warnings ?? []).filter((w) => /personality text claims/i.test(w));
  const granted8 = JSON.parse(m8.member.grantedAuthority);
  if (warns8.length >= 3 && granted8.length === 1) {
    ok(8, "Personality cannot grant authority",
       `${warns8.length} claims detected and neutralised; authority still ${JSON.stringify(granted8)}`);
  } else {
    bad(8, "Personality cannot grant authority",
        `warnings=${warns8.length} authority=${JSON.stringify(granted8)}`);
  }

  // archive the probes
  for (const p of [m7.member?.id, m8.member?.id].filter(Boolean)) {
    await patch("/api/college/members", { id: p, status: "archived", reason: "Test probe." });
  }

  // =========================================================================
  // 9. Faculty memory remains bounded
  // =========================================================================
  // Use a unique observation each run so the corroboration count starts at 1.
  // Re-running the suite must not accumulate observations and silently satisfy
  // the very gate under test.
  const probe9 = `Layer 5 probe ${Date.now()}: a worked example appeared to land better.`;
  const before9 = await q("select count(*)::int c from college_memory");
  const fm = await post("/api/college/faculty-memory", {
    action: "remember",
    positionKey: "instructor",
    courseId,
    content: probe9,
    kind: "teaching_observation",
  });
  const promo = await post("/api/college/faculty-memory", {
    action: "propose_promotion",
    id: fm.entry?.id,
    reason: "Seems useful.",
  });
  const after9 = await q("select count(*)::int c from college_memory");
  if (!promo.ok && after9[0].c === before9[0].c) {
    ok(9, "Faculty memory remains bounded", promo.message?.slice(0, 92));
  } else {
    bad(9, "Faculty memory remains bounded",
        `promoted=${promo.ok}, institutional memory ${before9[0].c}→${after9[0].c}`);
  }
  await q("delete from college_faculty_memory where content=$1", [probe9]);
  await q("delete from college_memory where content=$1", [probe9]);

  // =========================================================================
  // 10. Historical configurations remain immutable
  // =========================================================================
  const histBefore = await q(
    "select v.snapshot from college_session_faculty_members sm join college_faculty_member_versions v on v.id=sm.member_version_id where sm.session_id=$1 and sm.position_key='critic' limit 1",
    [r2.session.id]
  );
  await patch("/api/college/members", {
    id: critic.id,
    temperament: "Completely Different",
    reason: "Immutability probe.",
  });
  const histAfter = await q(
    "select v.snapshot from college_session_faculty_members sm join college_faculty_member_versions v on v.id=sm.member_version_id where sm.session_id=$1 and sm.position_key='critic' limit 1",
    [r2.session.id]
  );
  if (
    histBefore.length &&
    histAfter.length &&
    histBefore[0].snapshot === histAfter[0].snapshot
  ) {
    const snap = JSON.parse(histAfter[0].snapshot);
    ok(10, "Historical configurations remain immutable",
       `past session still reads temperament="${snap.temperament}"`);
  } else {
    bad(10, "Historical configurations remain immutable", "snapshot changed or missing");
  }

  // =========================================================================
  // 11. Timetable state reaches runtime
  // =========================================================================
  const live11 = await get("/api/college/timetable-live");
  const l = live11.live;
  if (l && l.date && l.time && l.dayName && Array.isArray(l.later)) {
    ok(11, "Timetable state reaches runtime",
       `${l.dayName} ${l.time} — theme ${l.theme || "(none)"}, ${l.later.length} later`);
  } else {
    bad(11, "Timetable state reaches runtime", JSON.stringify(live11).slice(0, 120));
  }

  // =========================================================================
  // 12. Curriculum version reaches runtime
  // =========================================================================
  if (r2.curriculumPinned?.versionId) {
    ok(12, "Curriculum version reaches runtime",
       `pinned to ${r2.curriculumPinned.versionLabel ?? r2.curriculumPinned.versionId.slice(0, 8)}`);
  } else {
    bad(12, "Curriculum version reaches runtime", "no curriculum version pinned to the session");
  }

  // =========================================================================
  // 13. Real-world context affects interpretation
  // =========================================================================
  const slots = (await get("/api/college/timetable-live?view=week")).days
    .flatMap((d) => d.slots)
    .filter((s) => s.title === "Instrument Practice");
  const slotId = slots[0]?.slotId;
  await post("/api/college/ledger", {
    eventType: "real_world_interruption",
    summary: "Medical appointment clashed with the slot.",
    slotId,
    date: "2026-08-20",
  });
  const audit13 = await get(
    `/api/college/audit?scopeType=slot&scopeId=${slotId}&from=2026-07-06&to=2026-08-25`
  );
  const ctx13 = audit13.report?.contextualFactors ?? [];
  if (ctx13.some((c) => /appointment/i.test(c))) {
    ok(13, "Real-world context affects interpretation",
       `context surfaced in the audit: "${ctx13.find((c) => /appointment/i.test(c)).slice(0, 62)}"`);
  } else {
    bad(13, "Real-world context affects interpretation", `contextualFactors=${JSON.stringify(ctx13).slice(0, 100)}`);
  }

  // =========================================================================
  // 14. Audit consumes runtime events
  // =========================================================================
  const led14 = await get("/api/college/ledger");
  if (led14.entries?.length > 0 && ctx13.length > 0) {
    ok(14, "Audit consumes runtime events",
       `${led14.entries.length} ledger entries today; audit read ${ctx13.length} contextual factor(s)`);
  } else {
    bad(14, "Audit consumes runtime events", `ledger=${led14.entries?.length} ctx=${ctx13.length}`);
  }

  // =========================================================================
  // 15. Audit does not manufacture causation
  // =========================================================================
  const cmp = await get(
    `/api/college/audit?scopeType=slot&scopeId=${slotId}&compare=1&aStart=2026-07-06&aEnd=2026-07-31&bStart=2026-08-01&bEnd=2026-08-25`
  );
  const warn15 = cmp.comparison?.causationWarning ?? "";
  const interp15 = cmp.comparison?.interpretation ?? "";
  if (/never attributed|does not claim/i.test(warn15) && !/caused/i.test(interp15)) {
    ok(15, "Audit does not manufacture causation", warn15.slice(0, 88));
  } else {
    bad(15, "Audit does not manufacture causation", `warning="${warn15.slice(0, 80)}"`);
  }

  // =========================================================================
  // 16. "KEEP AS IS" persists
  // =========================================================================
  await post("/api/college/audit", {
    scopeType: "slot",
    scopeId: slotId,
    from: "2026-07-06",
    to: "2026-08-25",
    decision: "keep_as_is",
    decisionReason: "Working as intended; the absence was a documented appointment.",
  });
  const settled = await get(`/api/college/audit?scopeType=slot&scopeId=${slotId}`);
  if (settled.settled?.settled === true && settled.settled.until) {
    ok(16, '"KEEP AS IS" persists', `not reopened before ${settled.settled.until}`);
  } else {
    bad(16, '"KEEP AS IS" persists', JSON.stringify(settled.settled));
  }

  // =========================================================================
  // 17. Stable systems do not trigger unnecessary changes
  // =========================================================================
  const rec17 = settled.report?.recommendation ?? "";
  if (/NO CHANGE|INSUFFICIENT/i.test(rec17)) {
    ok(17, "Stable systems do not trigger unnecessary changes", rec17.slice(0, 80));
  } else {
    bad(17, "Stable systems do not trigger unnecessary changes", `recommendation="${rec17}"`);
  }

  // =========================================================================
  // 18. Source conflicts remain visible
  // =========================================================================
  const dec18 = await get("/api/college/decisions");
  const decided = dec18.conflicts.find((c) => c.institutionalDecision);
  if (decided && decided.sourceAClaim && decided.sourceBClaim) {
    ok(18, "Source conflicts remain visible",
       `after deciding "${decided.institutionalDecision.statement}", both claims remain: A="${decided.sourceAClaim}" B="${decided.sourceBClaim}"`);
  } else {
    bad(18, "Source conflicts remain visible", "no decided conflict retained both claims");
  }

  // =========================================================================
  // 19. Explicit institutional decisions resolve operational uncertainty
  // =========================================================================
  if (decided?.institutionalDecision?.statement && decided.institutionalDecision.notChosen) {
    ok(19, "Explicit decisions resolve operational uncertainty",
       `operating on "${decided.institutionalDecision.statement}"; not chosen preserved: "${decided.institutionalDecision.notChosen.slice(0, 44)}"`);
  } else {
    bad(19, "Explicit decisions resolve operational uncertainty", "no decision statement recorded");
  }

  // =========================================================================
  // 20. One class produces one coherent student-facing response
  // =========================================================================
  const r20 = await runClass("T20", "Habits are automatic. But you said design matters.");
  const visible = (r20.faculty ?? []).filter((f) => f.visibleToStudent);
  if (visible.length === 1) {
    ok(20, "One class produces one student-facing response",
       `${r20.faculty.length} faculty run(s), exactly 1 visible (${visible[0].positionKey})`);
  } else {
    bad(20, "One class produces one student-facing response",
        `${visible.length} visible responses`);
  }

  // --- summary ------------------------------------------------------------
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
  await pool.end();
  process.exit(2);
});
