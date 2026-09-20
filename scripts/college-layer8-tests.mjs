// ============================================================================
// LAYER 8 — BOUNDED ACCOUNTABILITY: end-to-end assertions
// ============================================================================
// Run:  node scripts/college-layer8-tests.mjs
//
// The whole risk of this layer is that it becomes a nag. These assertions test
// the restraints, not the prose: that a missed commitment stays a fact, that
// the goal never moves on its own, that intensity changes wording and nothing
// else, and that a College proposal cannot become an obligation by itself.
//
// Self-cleaning: every fixture it creates, it removes.
// ============================================================================

import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const RUN = Date.now();
const TAG = `L8-${RUN}`;
let passed = 0;
const failures = [];

const ok = (n, title, detail) => {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${String(n).padStart(2)}. ${title}`);
  if (detail) console.log(`       ${detail}`);
};
const bad = (n, title, detail) => {
  failures.push(`${n}. ${title} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${String(n).padStart(2)}. ${title}`);
  console.log(`       \x1b[31m${detail}\x1b[0m`);
};

const get = async (p) => (await fetch(`${BASE}${p}`)).json();
const jsonCall = (method) => async (p, body) =>
  (
    await fetch(`${BASE}${p}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const post = jsonCall("POST");
const patch = jsonCall("PATCH");

const pool = new pg.Pool({ connectionString: DB });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/**
 * Remove this run's fixtures and un-park the caller's real commitments.
 * MUST run even when an assertion throws: an earlier version only cleaned up
 * on the happy path, so a crash at test 18 left five real commitments parked
 * as inactive and the Campus quietly under-reporting. A test harness that can
 * silently alter the state it is inspecting is worse than no harness.
 */
async function cleanup(parked) {
  await q("delete from college_commitments where statement like $1", [`${TAG}%`]);
  await q("delete from college_event_ledger where summary like $1", [`%${TAG}%`]);
  for (const p of parked) {
    await q("update college_commitments set active=true where id=$1", [p.id]);
  }
}

const mk = async (statement, extra = {}) => {
  const r = await post("/api/college/commitments", { statement, ...extra });
  return r.commitment?.id ?? null;
};
const close = (id, status, extra = {}) =>
  post("/api/college/commitments", { action: "close", id, status, ...extra });

let parked = [];

async function main() {
  console.log("\n\x1b[1mLAYER 8 — BOUNDED ACCOUNTABILITY\x1b[0m\n");

  // Park pre-existing commitments so counts are deterministic, then restore.
  parked = await q(
    "update college_commitments set active=false where active=true returning id"
  );

  // ==========================================================================
  // 1. A commitment is distinct from a goal
  // ==========================================================================
  {
    const goals = await q("select id,title from college_goals limit 1");
    const goalId = goals[0]?.id ?? null;
    const id = await mk(`${TAG} linked to a goal`, { goalId, dueDate: "2026-09-19", plannedMinutes: 60 });
    const rows = await q("select goal_id, statement from college_commitments where id=$1", [id]);
    if (id && (goalId ? rows[0].goal_id === goalId : rows[0].goal_id === null)) {
      ok(1, "A commitment is its own entity, optionally serving a goal",
         goalId ? `linked to "${goals[0].title}" without becoming it` : "unlinked commitment accepted");
    } else {
      bad(1, "A commitment is its own entity, optionally serving a goal", JSON.stringify(rows[0]));
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 2. An overdue commitment is NOT auto-marked missed
  // ==========================================================================
  {
    const id = await mk(`${TAG} overdue but unjudged`, { dueDate: "2026-09-01", plannedMinutes: 30 });
    const a = (await get("/api/college/commitments")).accountability;
    const mine = a.commitments.find((c) => c.id === id);
    const row = (await q("select status from college_commitments where id=$1", [id]))[0];
    if (row.status === "open" && mine?.overdue === true && /does not assume why/i.test(mine.condition)) {
      ok(2, "An overdue commitment stays open until someone says what happened",
         `status=open, overdue=true — "${mine.condition.slice(0, 68)}…"`);
    } else {
      bad(2, "An overdue commitment stays open until someone says what happened",
          `status=${row.status} overdue=${mine?.overdue}`);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 3. Missing a commitment does not move the goal
  // ==========================================================================
  {
    const before = await q("select id,title,status,timeframe,progress_note from college_goals order by title");
    const id = await mk(`${TAG} miss without consequence`, {
      dueDate: "2026-09-10",
      goalId: before[0]?.id ?? null,
      plannedMinutes: 90,
    });
    await close(id, "missed", { missedReasonKind: "circumstance", missedReason: "Harness" });
    const after = await q("select id,title,status,timeframe,progress_note from college_goals order by title");
    if (JSON.stringify(before) === JSON.stringify(after)) {
      ok(3, "A missed commitment never moves the goal",
         `${after.length} goal(s) byte-identical after a recorded miss`);
    } else {
      bad(3, "A missed commitment never moves the goal", "goal rows changed");
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 4. A miss is recorded as fact, not verdict
  // ==========================================================================
  {
    const id = await mk(`${TAG} fact not verdict`, { dueDate: "2026-09-10" });
    const r = await close(id, "missed", { missedReasonKind: "forgot" });
    const a = (await get("/api/college/commitments")).accountability;
    const mine = a.commitments.find((c) => c.id === id);
    const judgemental = /fail|lazy|should have|disappoint|bad/i.test(
      `${r.note} ${mine?.condition ?? ""}`
    );
    if (!judgemental && /not a verdict|not a conclusion/i.test(`${r.note} ${mine?.condition}`)) {
      ok(4, "A miss is recorded as a fact, never as a verdict",
         `"${mine.condition}"`);
    } else {
      bad(4, "A miss is recorded as a fact, never as a verdict",
          `judgemental=${judgemental}: ${mine?.condition}`);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 5. Reasons are recorded, never inferred
  // ==========================================================================
  {
    const id = await mk(`${TAG} unexplained`, { dueDate: "2026-09-10" });
    await close(id, "missed");
    const row = (await q("select missed_reason_kind, missed_reason from college_commitments where id=$1", [id]))[0];
    if (row.missed_reason_kind === "no_reason_given" && row.missed_reason === "") {
      ok(5, "An unexplained miss stays unexplained",
         `reason kind recorded as "no_reason_given" rather than guessed`);
    } else {
      bad(5, "An unexplained miss stays unexplained", JSON.stringify(row));
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 6–7. PATTERNS are named, and named only at the threshold
  // ==========================================================================
  {
    const ids = [];
    for (const d of ["2026-09-08", "2026-09-12"]) {
      const id = await mk(`${TAG} repeated thing`, { dueDate: d });
      await close(id, "missed", { missedReasonKind: "circumstance" });
      ids.push(id);
    }
    let a = (await get("/api/college/commitments")).accountability;
    const beforeThreshold = a.patterns.filter((p) => p.what.includes(TAG)).length;

    const third = await mk(`${TAG} repeated thing`, { dueDate: "2026-09-16" });
    await close(third, "missed", { missedReasonKind: "circumstance" });
    ids.push(third);

    a = (await get("/api/college/commitments")).accountability;
    const pat = a.patterns.find((p) => p.what.includes(TAG));

    if (beforeThreshold === 0 && pat) {
      ok(6, "A pattern is named only once it actually repeats",
         `silent at 2 misses; named at 3 (threshold ${a.settings.patternThreshold})`);
    } else {
      bad(6, "A pattern is named only once it actually repeats",
          `before=${beforeThreshold} after=${pat ? "named" : "absent"}`);
    }

    if (pat && /not changing the objective/i.test(pat.response)) {
      ok(7, "A detected pattern changes nothing on its own",
         `"${pat.response.slice(0, 82)}…"`);
    } else {
      bad(7, "A detected pattern changes nothing on its own", JSON.stringify(pat)?.slice(0, 120));
    }
    for (const id of ids) await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 8. Intensity changes wording, never facts
  // ==========================================================================
  {
    const id = await mk(`${TAG} intensity probe`, { dueDate: "2026-09-10", plannedMinutes: 60 });
    const seen = {};
    const facts = {};
    for (const intensity of ["gentle", "direct", "firm"]) {
      await patch("/api/college/commitments", { action: "set_intensity", intensity });
      const a = (await get("/api/college/commitments")).accountability;
      seen[intensity] = a.summary;
      facts[intensity] = JSON.stringify({
        made: a.made,
        completed: a.completed,
        missed: a.missed,
        open: a.open,
        rhythmDelta: a.rhythmDelta,
        patterns: a.patterns.length,
      });
    }
    const wordingDiffers = new Set(Object.values(seen)).size === 3;
    const factsIdentical = new Set(Object.values(facts)).size === 1;
    if (wordingDiffers && factsIdentical) {
      ok(8, "Intensity changes wording and nothing else",
         `3 distinct phrasings, identical facts ${facts.gentle}`);
    } else {
      bad(8, "Intensity changes wording and nothing else",
          `wordingDiffers=${wordingDiffers} factsIdentical=${factsIdentical}`);
    }
    await patch("/api/college/commitments", { action: "set_intensity", intensity: "direct" });
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 9. Intensity grants no authority
  // ==========================================================================
  {
    const r = await patch("/api/college/commitments", { action: "set_intensity", intensity: "firm" });
    if (/grants no|does not change what is true|cannot create an obligation/i.test(r.note ?? "")) {
      ok(9, "Even the firmest intensity grants no authority",
         `"${r.note.slice(0, 96)}…"`);
    } else {
      bad(9, "Even the firmest intensity grants no authority", JSON.stringify(r).slice(0, 130));
    }
    await patch("/api/college/commitments", { action: "set_intensity", intensity: "direct" });
  }

  // ==========================================================================
  // 10. A College proposal is not an obligation
  // ==========================================================================
  {
    const r = await post("/api/college/commitments", {
      statement: `${TAG} proposed by the College`,
      origin: "college_proposed",
      dueDate: "2026-09-25",
    });
    const id = r.commitment?.id;
    const row = (await q("select accepted, origin from college_commitments where id=$1", [id]))[0];
    if (row.accepted === false && row.origin === "college_proposed" && /never impose|inert/i.test(r.note)) {
      ok(10, "The College may propose a commitment but never impose one",
         `accepted=false on creation — "${r.note.slice(0, 74)}…"`);
    } else {
      bad(10, "The College may propose a commitment but never impose one", JSON.stringify(row));
    }
    const acc = await patch("/api/college/commitments", { action: "accept", id });
    if (acc.commitment?.accepted === true) {
      ok(11, "Only the student converts a proposal into a commitment",
         `"${acc.note.slice(0, 84)}…"`);
    } else {
      bad(11, "Only the student converts a proposal into a commitment", JSON.stringify(acc).slice(0, 120));
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 12. INTENDED → ACTUAL is preserved, not rounded
  // ==========================================================================
  {
    const id = await mk(`${TAG} intended vs actual`, { dueDate: "2026-09-18", plannedMinutes: 90 });
    await close(id, "partial", { actualMinutes: 35 });
    const row = (await q("select planned_minutes, actual_minutes, status from college_commitments where id=$1", [id]))[0];
    if (row.planned_minutes === 90 && row.actual_minutes === 35 && row.status === "partial") {
      ok(12, "Intended and actual are both kept, and partial is a real outcome",
         "planned 90 min, actual 35 min, status=partial — neither rounded away");
    } else {
      bad(12, "Intended and actual are both kept, and partial is a real outcome", JSON.stringify(row));
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 13. Review requires a stated response, and settles the matter
  // ==========================================================================
  {
    const id = await mk(`${TAG} to review`, { dueDate: "2026-09-05" });
    const refused = await patch("/api/college/commitments", { id });
    const reviewed = await patch("/api/college/commitments", {
      id,
      agreedResponse: "Leave it exactly as it is.",
      reviewAfter: "2099-01-01",
    });
    const a = (await get("/api/college/commitments")).accountability;
    const mine = a.commitments.find((c) => c.id === id);
    if (refused.error === "agreedResponse required" && mine?.settled === true) {
      ok(13, "A reviewed commitment stops reopening daily",
         `review demands a stated response; settled → "${mine.condition}"`);
    } else {
      bad(13, "A reviewed commitment stops reopening daily",
          `refused=${refused.error} settled=${mine?.settled}`);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 14. Cancelling is a legitimate decision, not a failure
  // ==========================================================================
  {
    const id = await mk(`${TAG} cancelled deliberately`, { dueDate: "2026-09-12" });
    await close(id, "cancelled");
    const a = (await get("/api/college/commitments")).accountability;
    const mine = a.commitments.find((c) => c.id === id);
    if (/decision, not a failure/i.test(mine?.condition ?? "")) {
      ok(14, "Cancelling is recorded as a decision, not a failure",
         `"${mine.condition}"`);
    } else {
      bad(14, "Cancelling is recorded as a decision, not a failure", mine?.condition);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 15. Rhythm requires something to be behind of
  // ==========================================================================
  {
    const id = await mk(`${TAG} undated intention`);
    const a = (await get("/api/college/commitments")).accountability;
    if (a.rhythmDelta === null && /no rhythm to be ahead or behind/i.test(a.rhythmNote)) {
      ok(15, "Being 'behind' requires a dated plan to be behind of",
         `"${a.rhythmNote}"`);
    } else {
      bad(15, "Being 'behind' requires a dated plan to be behind of",
          `rhythmDelta=${a.rhythmDelta} note="${a.rhythmNote}"`);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 16. No commitments means nothing to answer for
  // ==========================================================================
  {
    const a = (await get("/api/college/commitments")).accountability;
    if (a.made === 0 && /nothing to hold you to/i.test(a.summary) && a.quiet === true) {
      ok(16, "With no commitments the College asks nothing of you",
         `"${a.summary}"`);
    } else {
      bad(16, "With no commitments the College asks nothing of you",
          `made=${a.made} quiet=${a.quiet} summary="${a.summary}"`);
    }
  }

  // ==========================================================================
  // 17. Accountability reaches the briefing without duplicating itself
  // ==========================================================================
  {
    const id = await mk(`${TAG} briefing integration`, { dueDate: "2026-09-10", plannedMinutes: 45 });
    const r = await get("/api/college/briefing");
    const b = r.briefing;
    const inSection = b.accountability?.summary ?? "";
    const duplicated = (b.matters.conditions ?? []).some((c) => c === inSection);
    if (inSection && !duplicated) {
      ok(17, "Accountability appears once, in its own section",
         `summary present; not repeated in WORTH KNOWING`);
    } else {
      bad(17, "Accountability appears once, in its own section",
          `summary="${inSection.slice(0, 60)}" duplicated=${duplicated}`);
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 18. The briefing still never mutates, now that it reads commitments
  // ==========================================================================
  {
    const before = await q(
      "select (select count(*)::int from college_commitments) c, (select count(*)::int from college_event_ledger) l"
    );
    await get("/api/college/briefing");
    await fetch(`${BASE}/api/college/briefing?format=text`).then((r) => r.text());
    const after = await q(
      "select (select count(*)::int from college_commitments) c, (select count(*)::int from college_event_ledger) l"
    );
    if (before[0].c === after[0].c && before[0].l === after[0].l) {
      ok(18, "Reading accountability changes nothing",
         `commitments ${after[0].c}, ledger ${after[0].l} unchanged across 2 briefings`);
    } else {
      bad(18, "Reading accountability changes nothing",
          `${JSON.stringify(before[0])} → ${JSON.stringify(after[0])}`);
    }
  }

  // ==========================================================================
  // 19. The commitment vocabulary reaches the ledger
  // ==========================================================================
  {
    const id = await mk(`${TAG} ledger check`, { dueDate: "2026-09-19" });
    await close(id, "completed", { actualMinutes: 20 });
    const rows = await q(
      "select event_type from college_event_ledger where summary like $1 order by id",
      [`%${TAG} ledger check%`]
    );
    const types = rows.map((r) => r.event_type);
    if (types.includes("commitment_made") && types.includes("commitment_closed")) {
      ok(19, "Making and closing a commitment are distinct ledger events",
         types.join(" → "));
    } else {
      bad(19, "Making and closing a commitment are distinct ledger events", types.join(", ") || "none");
    }
    await q("delete from college_commitments where id=$1", [id]);
    await q("delete from college_event_ledger where summary like $1", [`%${TAG}%`]);
  }

  // ==========================================================================
  // 20. Accountability never touches the curriculum or timetable
  // ==========================================================================
  {
    const beforeC = await q("select id,code,title,status from college_courses order by code");
    const beforeS = await q("select count(*)::int n from college_timetable_template_slots where active=true");
    const id = await mk(`${TAG} isolation`, { dueDate: "2026-09-02" });
    await close(id, "missed", { missedReasonKind: "chose_not_to" });
    await get("/api/college/briefing");
    const afterC = await q("select id,code,title,status from college_courses order by code");
    const afterS = await q("select count(*)::int n from college_timetable_template_slots where active=true");
    if (JSON.stringify(beforeC) === JSON.stringify(afterC) && beforeS[0].n === afterS[0].n) {
      ok(20, "Accountability never reaches the curriculum or timetable",
         `${afterC.length} course(s), ${afterS[0].n} slot(s) byte-identical after a deliberate miss`);
    } else {
      bad(20, "Accountability never reaches the curriculum or timetable", "curriculum or timetable changed");
    }
    await q("delete from college_commitments where id=$1", [id]);
  }

  // ==========================================================================
  // 21–22. SLOT != CLASS — the College does not invite you into scheduled life
  // ==========================================================================
  {
    // Tuesday 14:30 is "Digital Lab", one of only 2 academic slots in 77.
    const academic = await get(
      `/api/college/briefing?at=${encodeURIComponent("2026-09-22T14:30:00+10:00")}`
    );
    const an = academic.briefing.next;
    if (an.classAvailable === true && an.lifeActivity === false) {
      ok(21, "An academic slot invites a class",
         `"${an.title}" → BEGIN CLASS`);
    } else {
      bad(21, "An academic slot invites a class",
          `classAvailable=${an.classAvailable} life=${an.lifeActivity} title=${an.title}`);
    }

    // Sunday 15:30 is "Time with Kirra" — relationship time.
    const life = await get(
      `/api/college/briefing?at=${encodeURIComponent("2026-09-20T15:30:00+10:00")}`
    );
    const ln = life.briefing.next;
    const noDemand = /nothing is being asked of you/i.test(ln.handoff);
    if (ln.classAvailable === false && ln.lifeActivity === true && noDemand) {
      ok(22, "Scheduled life is reported, never turned into an obligation",
         `"${life.briefing.where.currentActivity}" (${ln.activityType}) — no class offered`);
    } else {
      bad(22, "Scheduled life is reported, never turned into an obligation",
          `classAvailable=${ln.classAvailable} life=${ln.lifeActivity} handoff="${ln.handoff}"`);
    }
  }

  await cleanup(parked);

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m\n`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
  }
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test harness error:", e.message);
  console.error(e.stack);
  // Restore before dying, or the harness corrupts the state it was inspecting.
  await cleanup(parked).catch((c) => console.error("cleanup failed:", c.message));
  console.error(`Restored ${parked.length} parked commitment(s).`);
  await pool.end().catch(() => {});
  process.exit(1);
});
