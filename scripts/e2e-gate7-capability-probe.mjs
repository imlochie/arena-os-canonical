/**
 * e2e-gate7-capability-probe.mjs — seam-level capability dress rehearsal
 * for the two-window seam proposal (docs/gate7-two-window-seam-proposal.md).
 *
 * QUESTION: does the OWNER's required trend conclusion actually form,
 * through the genuine seam, on the exact payload shape the proposal asks
 * upstream to emit ("recent_activity" + "recent_activity_previous" rows,
 * parity key `watches`, adjacent half-open windows, one derivedAt anchor)?
 *
 * Honesty markers: the evidence here is the SYNTHETIC lab persona `g7cap`
 * (dev-fixture, startup-validated against the regenerated contract) — it
 * is NOT producer-authored evidence, NOT the real capture, and proves
 * nothing about upstream. It proves exactly one thing about ARENA: if the
 * proposed row shape crosses the seam, the existing machinery licenses
 * the bounded two-window trend with the full retention list — making the
 * "zero Arena delta" claim in the proposal demonstrated, not inferred.
 *
 * Chain (no bypass, no test-only adapter): lab HTTP → read-only client →
 * generated-contract validation → Gate-6 normalize → lattice → calculus →
 * renderer. Writes docs/gate7-two-window-capability-probe.md; exits
 * non-zero on any failed check.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { createPersonalisationEvidenceClient } from "../src/lib/personalisation/client.ts";
import { normalizePersonalisationContext } from "../src/lib/personalisation/context.ts";
import { temporalClaim, compareWindows } from "../src/lib/archive-reasoning/temporal.ts";
import { surfaceContradictions } from "../src/lib/archive-reasoning/contradictions.ts";
import { renderConclusion, assertRendererVocabulary } from "../src/lib/archive-reasoning/render.ts";

const PORT = 4722;
const SCOPE = "plex:account-main:tv";

const rows = [];
const failures = [];
function check(group, name, pass, detail) {
  rows.push(`| ${group} | ${name} | ${pass ? "✅" : "❌"} ${pass ? detail : `**FAILED** — ${detail}`} |`);
  if (!pass) failures.push(`[${group}] ${name} — ${detail}`);
}

function startLab() {
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/register-src-loader.mjs", "scripts/mock-personalisation-lab.mjs", String(PORT)],
    { env: { ...process.env, REAL_CAPTURE_FILE: "", ADVERSARIAL_PERSONA: "g7cap" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += String(c); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`lab did not start.\n${stderr}`)); }, 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`lab exited (${code}).\n${stderr}`)); });
  }).then((running) => { running.removeAllListeners("exit"); return running; });
}

/* ------------------------------ the run ---------------------------------- */

let child = null;
let pack;
try {
  child = await startLab();
  const client = createPersonalisationEvidenceClient(
    { baseUrl: `http://127.0.0.1:${PORT}`, authMode: "local", ownerId: "gate7-capability-probe", timeoutMs: 4000 },
    { mode: "local", ownerId: "gate7-capability-probe" },
  );
  pack = normalizePersonalisationContext(await client.getPersonalisationContext());
} finally {
  if (child) child.kill("SIGKILL");
}

const ts = pack.evidence.temporalSignals;
check("INGRESS", "proposed two-row shape crosses the seam validated + verbatim (2 temporal items, classes/signalTypes preserved)",
  ts.length === 2
    && ts.every((item) => item.evidenceClass === "temporal_signal")
    && ts[0].signalType === "recent_activity" && ts[1].signalType === "recent_activity_previous"
    && Object.isFrozen(ts[0]) && Object.isFrozen(ts[1]),
  `temporalSignals=${ts.length} types=[${ts.map((i) => i.signalType).join(", ")}]`);

const CURRENT = ts[0].value.window;
const PREVIOUS = ts[1].value.window;

// The comparison through the existing calculus, twice (determinism pair).
const REFS = [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 1 }];
const trendA = compareWindows(pack, REFS, { metricKey: "watches", scopeIdentity: SCOPE, rule: "temporal.compare.v1:watches" });
const trendB = compareWindows(pack, REFS, { metricKey: "watches", scopeIdentity: SCOPE, rule: "temporal.compare.v1:watches" });
const claim = trendA.claim;

/* --------------------- owner retention list, item by item ---------------- */

check("RETAIN", "both windows — verbatim identification, no reconstruction (sorted prev-first)",
  claim.perWindow.length === 2
    && claim.perWindow[0].window.startsAt === PREVIOUS.startsAt
    && claim.perWindow[0].window.endsAt === PREVIOUS.endsAt
    && claim.perWindow[1].window.startsAt === CURRENT.startsAt
    && claim.perWindow[1].window.endsAt === CURRENT.endsAt,
  `perWindow=[${claim.perWindow[0].window.startsAt}..${claim.perWindow[0].window.endsAt} | ${claim.perWindow[1].window.startsAt}..${claim.perWindow[1].window.endsAt}]`);

check("RETAIN", "both evidence references (distinct rows; members + loadBearing)",
  claim.perWindow[0].member.index === 1 && claim.perWindow[1].member.index === 0
    && JSON.stringify(trendA.derivation.loadBearing) === JSON.stringify(REFS.map((r) => ({ ...r })).sort((a, b) => a.index - b.index))
    && claim.members.length === 2,
  `members=${JSON.stringify(claim.members)}`);

check("RETAIN", "the compared metric is the parity key, per-window values intact",
  claim.perWindow[0].value === 1 && claim.perWindow[1].value === 2 && claim.metricKey === "watches",
  `values=[${claim.perWindow.map((p) => p.value).join(", ")}]`);

check("RETAIN", "explicit comparison direction — delta arithmetic, never an adjective",
  claim.comparisons.length === 1 && claim.comparisons[0].delta === 1 && claim.comparisons[0].relation === "greater",
  `delta=+${claim.comparisons[0].delta} relation=${claim.comparisons[0].relation}`);

check("RETAIN", "epistemic ceiling = derived (the calculus computes the ceiling, never the caller)",
  trendA.epistemicStatus === "derived", `status=${trendA.epistemicStatus}`);

check("RETAIN", "scope identity explicit", trendA.scopeIdentity === SCOPE, `scope=${trendA.scopeIdentity}`);

check("RETAIN", "deterministic derivation rule + byte-identical re-computation (no clocks)",
  trendA.derivation.rule === "temporal.compare.v1:watches"
    && JSON.stringify(trendA.claim) === JSON.stringify(trendB.claim)
    && trendA.derivation.rule === trendB.derivation.rule,
  `rule=${trendA.derivation.rule}; claim byte-stable=${JSON.stringify(trendA.claim) === JSON.stringify(trendB.claim)}`);

check("RETAIN", "inspectable lineage: conclusion frozen, load-bearing refs frozen, envelope span honest",
  Object.isFrozen(trendA) && Object.isFrozen(claim)
    && trendA.window.label === "comparison_span"
    && trendA.window.startsAt === PREVIOUS.startsAt && trendA.window.endsAt === CURRENT.endsAt,
  `envelope=[${trendA.window.startsAt}..${trendA.window.endsAt}] label=${trendA.window.label}`);

// Non-invention proof: the previous window's endsAt (2026-06-21) ≠ the
// items' derivedAt (2026-09-19T05:00Z) — nothing was anchored from time.
check("IDENTIFICATION", "prev window retained while NOT equal to derivedAt: it was consumed as declared, never derivedAt−90d",
  claim.perWindow[0].window.endsAt !== ts[1].derivedAt
    && ts[0].derivedAt === ts[1].derivedAt // one producer anchor, as proposed
    && extractWindowValue(ts[1]).endsAt === PREVIOUS.endsAt,
  `prev.endsAt=${PREVIOUS.endsAt} vs derivedAt=${ts[1].derivedAt} (distinct — declaration consumed verbatim)`);
function extractWindowValue(item) { return item.value.window; }

// Adjacent probes the retention list implies:
const asOf = temporalClaim(pack, REFS[1]);
check("ADJACENT", "the previous row alone supports its own bounded as-of claim (same calculus path as row 14)",
  asOf.epistemicStatus === "derived"
    && asOf.claim.window.startsAt === PREVIOUS.startsAt && asOf.claim.window.endsAt === PREVIOUS.endsAt,
  `as-of window=[${asOf.claim.window.startsAt}..${asOf.claim.window.endsAt}]`);

check("ADJACENT", "contradiction lane stays silent (same lineage + non-overlapping windows: both stand, no fabricated dispute)",
  surfaceContradictions(pack, "temporalSignals").length === 0,
  `surfaced=${surfaceContradictions(pack, "temporalSignals").length}`);

/* ------------------------------- renderer -------------------------------- */

const rendered = renderConclusion(trendA);
let vocabularyClean = true;
let vocabularyNote = "clean";
try {
  assertRendererVocabulary(rendered.statement.replace(/"[^"]*"/g, ""));
} catch (error) {
  vocabularyClean = false;
  vocabularyNote = String(error.message ?? error).slice(0, 120);
}
check("RENDER", "renderer speaks only the earned arithmetic (vocabulary scan with evidence strings masked)",
  vocabularyClean, vocabularyNote);

/* -------------------------------- ledger --------------------------------- */

const pass = failures.length === 0;
const lines = [
  `# Gate 7 — two-window capability dress rehearsal`,
  ``,
  `> **Date:** 2026-09-19 · **Pose:** SYNTHETIC lab persona \`g7cap\` emitting`,
  `> exactly the shape proposed in docs/gate7-two-window-seam-proposal.md.`,
  `> **Not real evidence; proves Arena-side capability only.**`,
  `> **Command:** \`node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-capability-probe.mjs\``,
  `> **Verdict:** **${pass ? "PASS" : "FAIL"}** (${rows.length}/${rows.length - failures.length} checks${pass ? "" : `, ${failures.length} failed`})`,
  ``,
  `If upstream lands the proposal, THIS is the conclusion the real-evidence`,
  `battery will re-verify with producer-authored bounds (windows here are`,
  `persona constants, deliberately indie-but-honest half-open spans):`,
  ``,
  "| # | Check | Outcome |",
  "|---|-------|---------|",
  ...rows,
  ``,
  `## The deterministic trend conclusion (verbatim claim)`,
  ``,
  "```json",
  JSON.stringify(claim, null, 2),
  "```",
  ``,
  `- rendered statement: "${rendered.statement}"`,
  `- epistemic: ${trendA.epistemicStatus} · scope: ${trendA.scopeIdentity} · rule: ${trendA.derivation.rule}`,
  `- load-bearing: ${JSON.stringify(trendA.derivation.loadBearing)}`,
  ``,
  `**What this establishes:** once the evidence arrives *as rows*,`,
  `\`compareWindows("watches")\` over the pair yields the bounded comparison`,
  `with every retention item intact — the calculus needed no contact with`,
  `the problem beyond identifying two declared windows. The remaining`,
  `question is purely upstream emission (proposal, owner-gated).`,
];
if (failures.length) {
  lines.push(``, `## Failures`, ...failures.map((f) => `- ${f}`));
}
writeFileSync("docs/gate7-two-window-capability-probe.md", lines.join("\n") + "\n");
console.log(`Gate 7 · two-window capability probe: ${pass ? "PASS" : `FAIL (${failures.length})`} (${rows.length - failures.length}/${rows.length})`);
if (failures.length) process.exit(1);
