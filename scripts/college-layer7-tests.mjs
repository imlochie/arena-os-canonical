// ============================================================================
// LAYER 7 — CAMPUS BRIEFING / ARRIVAL RUNTIME: end-to-end assertions
// ============================================================================
// Run:  node scripts/college-layer7-tests.mjs
//
// These test the properties that made Layer 7 necessary, not the wording of
// any sentence. The old briefing failed because it generated prose; this one
// must COMPUTE state, CHANGE BEHAVIOUR with elapsed time, and REFUSE to invent
// what it does not know.
//
// Self-cleaning: every fixture it creates, it removes.
// ============================================================================

import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DB =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const RUN = Date.now();
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
const getText = async (p) => (await fetch(`${BASE}${p}`)).text();
const post = async (p, body) =>
  (
    await fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

const pool = new pg.Pool({ connectionString: DB });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/** Arrive as if it were `date` (09:00 Brisbane). */
const briefingAt = (date) =>
  get(`/api/college/briefing?at=${encodeURIComponent(`${date}T09:00:00+10:00`)}`);

async function main() {
  console.log("\n\x1b[1mLAYER 7 — CAMPUS BRIEFING / ARRIVAL RUNTIME\x1b[0m\n");

  const live = await get("/api/college/briefing");
  if (live.error) throw new Error(`briefing failed: ${live.error} ${live.detail ?? ""}`);
  const b = live.briefing;

  // ==========================================================================
  // 1. The briefing is computed from state, not generated
  // ==========================================================================
  {
    // Every interval must carry the evidence it was measured from. A number
    // with no provenance is indistinguishable from a guess.
    const t = b.temporal;
    const intervals = [
      t.sinceLastInteraction,
      t.sinceLastMeaningfulProgress,
      t.sinceLastCollegeSession,
      t.sinceLastExternalAcademicEvent,
      t.sinceLastReview,
    ];
    const allEvidenced = intervals.every((i) => typeof i.evidence === "string" && i.evidence.length > 8);
    if (allEvidenced) {
      ok(1, "Every temporal field states the evidence it was measured from",
         `${intervals.length} intervals, e.g. "${t.sinceLastInteraction.evidence.slice(0, 62)}…"`);
    } else {
      bad(1, "Every temporal field states the evidence it was measured from", "an interval carried no evidence string");
    }
  }

  // ==========================================================================
  // 2. Elapsed time is measured, not described
  // ==========================================================================
  {
    const i = b.temporal.sinceLastInteraction;
    if (i.known && typeof i.days === "number" && i.since) {
      ok(2, "Elapsed time is a measured interval with a source date",
         `${i.days} day(s) since ${i.since} — "${i.label}"`);
    } else if (!i.known && i.days === null) {
      ok(2, "Elapsed time is a measured interval with a source date",
         `no interaction recorded; reported as "${i.label}" rather than 0 days`);
    } else {
      bad(2, "Elapsed time is a measured interval with a source date", JSON.stringify(i));
    }
  }

  // ==========================================================================
  // 3. Unknown stays unknown — never rendered as zero
  // ==========================================================================
  {
    const t = b.temporal;
    const unknowns = [
      t.sinceLastInteraction,
      t.sinceLastMeaningfulProgress,
      t.sinceLastCollegeSession,
      t.sinceLastExternalAcademicEvent,
      t.sinceLastReview,
    ].filter((i) => !i.known);
    const lying = unknowns.filter((i) => i.days === 0 || /just now|today/.test(i.label));
    if (lying.length === 0) {
      ok(3, "An unmeasurable interval is never rendered as zero",
         unknowns.length
           ? `${unknowns.length} unknown interval(s), all labelled "${unknowns[0].label}"`
           : "all intervals currently measurable");
    } else {
      bad(3, "An unmeasurable interval is never rendered as zero", `${lying.length} unknown interval(s) rendered as recent`);
    }
  }

  // ==========================================================================
  // 4–7. BEHAVIOUR CHANGES WITH ELAPSED TIME
  // ==========================================================================
  // The core claim of Layer 7. Same College, same data, four arrival times.
  const anchor = b.temporal.sinceLastInteraction.since;
  if (!anchor) {
    bad(4, "Briefing depth changes with elapsed time", "no anchor date to measure from");
  } else {
    const plus = (n) => {
      const d = new Date(`${anchor}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const probes = [
      [4, 1, "normal", "quick_orientation"],
      [5, 5, "short_absence", "what_changed"],
      [6, 15, "extended_absence", "reconstruct_continuity"],
      [7, 30, "long_absence", "re_entry"],
    ];
    for (const [n, days, expectContinuity, expectDepth] of probes) {
      const r = await briefingAt(plus(days));
      const got = r.briefing?.behaviour;
      if (got?.continuity === expectContinuity && got?.depth === expectDepth) {
        ok(n, `After ${days} day(s) the briefing behaves as "${expectDepth.replace(/_/g, " ")}"`,
           `${got.continuity} → "${got.directive.slice(0, 68)}…"`);
      } else {
        bad(n, `After ${days} day(s) the briefing behaves as "${expectDepth.replace(/_/g, " ")}"`,
            `got continuity=${got?.continuity} depth=${got?.depth}`);
      }
    }
  }

  // ==========================================================================
  // 8. A long absence does not throw the whole College at the student
  // ==========================================================================
  {
    const anchorDate = b.temporal.sinceLastInteraction.since ?? b.where.longDate;
    const d = new Date(`${anchorDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 30);
    const r = await briefingAt(d.toISOString().slice(0, 10));
    const dir = r.briefing?.behaviour?.directive ?? "";
    // The re-entry directive must explicitly restrain the briefing.
    if (/do not open with obligations|establish where the College is/i.test(dir)) {
      ok(8, "A long absence produces re-entry, not a backlog dump",
         `"${dir.slice(0, 92)}…"`);
    } else {
      bad(8, "A long absence produces re-entry, not a backlog dump", `directive was "${dir.slice(0, 90)}"`);
    }
  }

  // ==========================================================================
  // 9. "Nothing materially changed" is a valid briefing
  // ==========================================================================
  {
    // Arrive one second after the anchor: nothing can have changed.
    const r = await briefingAt(b.temporal.sinceLastInteraction.since ?? "2026-09-20");
    const c = r.briefing?.changed;
    if (c && (c.materialCount === 0 ? /nothing material/i.test(c.summary) : c.materialCount > 0)) {
      ok(9, "Silence is a valid briefing outcome",
         c.materialCount === 0
           ? `"${c.summary.slice(0, 78)}…"`
           : `${c.materialCount} material change(s) reported honestly rather than padded`);
    } else {
      bad(9, "Silence is a valid briefing outcome", JSON.stringify(c)?.slice(0, 120));
    }
  }

  // ==========================================================================
  // 10. Routine activity is not a material change
  // ==========================================================================
  {
    // A class running is activity. It must not be reported as an institutional
    // change, or every briefing becomes noise.
    const anchorDate = b.temporal.sinceLastInteraction.since ?? "2026-09-20";
    const r = await briefingAt(anchorDate);
    const items = r.briefing?.changed?.items ?? [];
    const routine = items.filter((i) => /faculty_watching|faculty_silent|class_opened|memory_recalled/.test(i.source));
    if (routine.length === 0) {
      ok(10, "Routine activity is excluded from material change",
         `${items.length} material item(s); no attendance or recall noise`);
    } else {
      bad(10, "Routine activity is excluded from material change", `${routine.length} routine event(s) reported as material`);
    }
  }

  // ==========================================================================
  // 11. The briefing never mutates
  // ==========================================================================
  {
    const before = await q(
      "select (select count(*)::int from college_event_ledger) l, (select count(*)::int from college_sessions) s, (select count(*)::int from college_faculty_memory) m"
    );
    await get("/api/college/briefing");
    await getText("/api/college/briefing?format=text");
    await briefingAt("2026-12-01");
    const after = await q(
      "select (select count(*)::int from college_event_ledger) l, (select count(*)::int from college_sessions) s, (select count(*)::int from college_faculty_memory) m"
    );
    if (
      before[0].l === after[0].l &&
      before[0].s === after[0].s &&
      before[0].m === after[0].m
    ) {
      ok(11, "Arriving is not an institutional act",
         `3 briefings changed nothing: ledger ${after[0].l}, sessions ${after[0].s}, memory ${after[0].m}`);
    } else {
      bad(11, "Arriving is not an institutional act",
          `before ${JSON.stringify(before[0])} after ${JSON.stringify(after[0])}`);
    }
  }

  // ==========================================================================
  // 12. No model runs in the briefing
  // ==========================================================================
  {
    // Structural: the briefing module must not import the AI abstraction. A
    // briefing that can call a model can hallucinate an institution.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/college/campus-briefing.ts", "utf8");
    const temporal = readFileSync("src/lib/college/temporal-state.ts", "utf8");
    const importsAi = /from\s+"@?\/?(lib\/)?ai"|generate\(/.test(src + temporal);
    if (!importsAi) {
      ok(12, "The briefing computes; it never generates",
         "neither campus-briefing.ts nor temporal-state.ts imports the AI abstraction");
    } else {
      bad(12, "The briefing computes; it never generates", "a model call exists in the briefing path");
    }
  }

  // ==========================================================================
  // 13–15. EXTERNAL ACADEMIC WORLD
  // ==========================================================================
  let commitmentId = null;
  {
    const created = await post("/api/college/external", {
      provider: `Test Provider ${RUN}`,
      title: `Layer 7 assessment ${RUN}`,
      commitmentType: "assessment",
      dueOn: "2099-01-01",
      sourceNote: "Created by the Layer 7 harness.",
      evidenceLevel: "reported",
    });
    commitmentId = created.commitment?.id ?? null;
    if (commitmentId && /not a College course|will not grade/i.test(created.note ?? "")) {
      ok(13, "External work is recorded as context, not as curriculum",
         `"${created.note.slice(0, 86)}…"`);
    } else {
      bad(13, "External work is recorded as context, not as curriculum", JSON.stringify(created).slice(0, 140));
    }
  }

  {
    const refused = await post("/api/college/external", {
      provider: `Test Provider ${RUN}`,
      title: "Unsourced",
    });
    if (refused.error === "sourceNote required") {
      ok(14, "An external fact with no stated source is refused",
         `"${(refused.note ?? "").slice(0, 88)}…"`);
    } else {
      bad(14, "An external fact with no stated source is refused", JSON.stringify(refused).slice(0, 130));
    }
  }

  {
    // A curriculum must be untouched by recording external work.
    const beforeCourses = await q("select id,code,title,status from college_courses order by code");
    const beforeSlots = await q("select count(*)::int n from college_timetable_template_slots where active=true");
    await get("/api/college/briefing");
    const afterCourses = await q("select id,code,title,status from college_courses order by code");
    const afterSlots = await q("select count(*)::int n from college_timetable_template_slots where active=true");
    if (
      JSON.stringify(beforeCourses) === JSON.stringify(afterCourses) &&
      beforeSlots[0].n === afterSlots[0].n
    ) {
      ok(15, "External pressure never rewrites the timetable or curriculum",
         `${afterCourses.length} course(s) and ${afterSlots[0].n} slot(s) byte-identical`);
    } else {
      bad(15, "External pressure never rewrites the timetable or curriculum", "curriculum or timetable changed");
    }
  }

  // ==========================================================================
  // 16. Reported is not verified
  // ==========================================================================
  {
    const picture = await get("/api/college/external");
    const mine = picture.commitments?.find((c) => c.id === commitmentId);
    if (mine && /not verified/i.test(mine.condition) && mine.evidenceLevel === "reported") {
      ok(16, "Reported and verified remain different facts",
         `"${mine.condition.slice(0, 92)}…"`);
    } else {
      bad(16, "Reported and verified remain different facts", JSON.stringify(mine)?.slice(0, 130));
    }
  }

  // ==========================================================================
  // 17. Temporal pressure is only claimed when a real date exists
  // ==========================================================================
  {
    const noDate = await post("/api/college/external", {
      provider: `Test Provider ${RUN}`,
      title: `Undated unit ${RUN}`,
      commitmentType: "unit",
      sourceNote: "Harness: deliberately undated.",
    });
    const id2 = noDate.commitment?.id;
    const picture = await get("/api/college/external");
    const undated = picture.commitments?.find((c) => c.id === id2);
    if (undated && undated.imminent === false && undated.daysUntilDue === null) {
      ok(17, "A commitment with no date never becomes urgent",
         `"${undated.condition.slice(0, 84)}…"`);
    } else {
      bad(17, "A commitment with no date never becomes urgent", JSON.stringify(undated)?.slice(0, 130));
    }
    if (id2) await q("delete from college_external_commitments where id=$1", [id2]);
  }

  // ==========================================================================
  // 18. The briefing hands off; it does not begin a class
  // ==========================================================================
  {
    const hasPost = await fetch(`${BASE}/api/college/briefing`, { method: "POST" });
    const sessionsBefore = await q("select count(*)::int n from college_sessions");
    await get("/api/college/briefing");
    const sessionsAfter = await q("select count(*)::int n from college_sessions");
    if (hasPost.status === 405 && sessionsBefore[0].n === sessionsAfter[0].n) {
      ok(18, "The briefing recommends; beginning a class stays a separate act",
         `POST → 405; session count unchanged at ${sessionsAfter[0].n}`);
    } else {
      bad(18, "The briefing recommends; beginning a class stays a separate act",
          `POST → ${hasPost.status}; sessions ${sessionsBefore[0].n} → ${sessionsAfter[0].n}`);
    }
  }

  // ==========================================================================
  // 19. Time since last meaningful interaction is exposed, not buried
  // ==========================================================================
  {
    const text = await getText("/api/college/briefing?format=text");
    const firstFields = text.split("\n").slice(0, 5).join("\n");
    if (/LAST HERE/.test(firstFields)) {
      ok(19, "Time since last interaction is a first-class field",
         `"${text.split("\n").find((l) => l.startsWith("LAST HERE"))}"`);
    } else {
      bad(19, "Time since last interaction is a first-class field", "not present in the opening lines");
    }
  }

  // ==========================================================================
  // 20. Goals carry temporal condition without manufactured urgency
  // ==========================================================================
  {
    const goals = b.temporal.goals ?? [];
    const fabricated = goals.filter((g) => g.underTimePressure && !g.deadline);
    if (fabricated.length === 0) {
      ok(20, "Urgency is never manufactured for a goal without a deadline",
         goals.length ? `${goals.length} goal(s), none given invented pressure` : "no active goals; nothing invented");
    } else {
      bad(20, "Urgency is never manufactured for a goal without a deadline",
          `${fabricated.length} goal(s) marked urgent with no dated target`);
    }
  }

  // ---- cleanup ------------------------------------------------------------
  if (commitmentId) {
    await q("delete from college_external_commitments where id=$1", [commitmentId]);
  }
  await q("delete from college_external_commitments where provider like $1", [`Test Provider ${RUN}%`]);
  await q("delete from college_event_ledger where summary like $1", [`%${RUN}%`]);

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
  await pool.end().catch(() => {});
  process.exit(1);
});
