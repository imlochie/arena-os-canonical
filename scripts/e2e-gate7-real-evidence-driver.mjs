/**
 * e2e-gate7-real-evidence-driver.mjs — the first REAL-EVIDENCE reasoning
 * pass. Gate 7's own question, finally not hypothetical:
 *
 *   Given real provenance-backed evidence, what is Arena actually
 *   permitted to conclude?
 *
 * The evidence is not a fixture invented for suspicion: it is the actual
 * JSON upstream's own runtime emitted at
 * imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a
 * — captured verbatim from getPersonalisationContext() after redoing the
 * exact seed of upstream's own regression test ("rebuilds explainable
 * recent, long-term, rewatch, scope, and explicit signals") with the
 * producer's own pipeline, and pinned at
 * scripts/fixtures/real-evidence-upstream-capture.json.
 *
 * Chain: capture file → mock-personalisation-lab replay mode (real HTTP,
 * startup contract self-validation) → REAL read-only client → generated
 * contract runtime validation → Gate-6 normalize → 7.1–7.4 calculus →
 * renderer. No calculus changes; no new conclusion kinds; no repair of
 * what the evidence can't license (findings are reported, not patched).
 *
 * Writes docs/e2e-gate7-real-evidence.md deterministically and exits
 * non-zero on any failed check.
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

import { createPersonalisationEvidenceClient } from "../src/lib/personalisation/client.ts";
import { normalizePersonalisationContext } from "../src/lib/personalisation/context.ts";
import { restateEvidence, aggregateEvidence } from "../src/lib/archive-reasoning/synthesizers.ts";
import { temporalClaim, compareWindows } from "../src/lib/archive-reasoning/temporal.ts";
import { surfaceContradictions } from "../src/lib/archive-reasoning/contradictions.ts";
import { buildConclusion, ReasoningRejectError } from "../src/lib/archive-reasoning/lattice.ts";
import { renderConclusion, assertRendererVocabulary, RenderError } from "../src/lib/archive-reasoning/render.ts";

const CAPTURE_FILE = "scripts/fixtures/real-evidence-upstream-capture.json";
const CAPTURE = JSON.parse(readFileSync(CAPTURE_FILE, "utf8"));
const WINDOW_ALL = { label: "all_ingested" };
const SCOPE = "plex:movies-v1";
const PORT = 4721;

/** Caller-declared rolling window identity (C3: identity, not a merge):
 *  anchored at the evidence item's own derivedAt — arithmetic the
 *  caller states, never the calculus invents. */
function rollingWindow(endsAt, days) {
  const end = Date.parse(endsAt);
  const start = new Date(end - days * 86400000).toISOString();
  return { label: `rolling_${days}d`, startsAt: start, endsAt };
}
const TEMPORAL_DERIVED_AT = CAPTURE.context.temporalSignals[0].derivedAt;
const WINDOW_90D = rollingWindow(TEMPORAL_DERIVED_AT, 90);

/* ------------------------------ harness ---------------------------------- */

function startLab() {
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/register-src-loader.mjs", "scripts/mock-personalisation-lab.mjs", String(PORT)],
    { env: { ...process.env, REAL_CAPTURE_FILE: CAPTURE_FILE, ADVERSARIAL_PERSONA: "" }, stdio: ["ignore", "pipe", "pipe"] },
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

async function fetchPack() {
  const client = createPersonalisationEvidenceClient(
    { baseUrl: `http://127.0.0.1:${PORT}`, authMode: "local", ownerId: "gate7-real-evidence", timeoutMs: 4000 },
    { mode: "local", ownerId: "gate7-real-evidence" },
  );
  return normalizePersonalisationContext(await client.getPersonalisationContext());
}

/* ------------------------------ scorebook -------------------------------- */

const rows = [];
const failures = [];
const certifiedStatements = [];

function row(group, check, outcome, pass, note = "") {
  rows.push({ group, check, outcome, pass, note });
  if (!pass) failures.push(`[${group}] ${check} — ${outcome}${note ? ` (${note})` : ""}`);
}

function attemptVoid(group, check, fn, { expectedKinds = null } = {}) {
  try {
    const conclusion = fn();
    row(group, check, `UNEXPECTEDLY CERTIFIED (status ${conclusion.epistemicStatus})`, false);
    return null;
  } catch (error) {
    if (error instanceof RenderError) {
      row(group, check, `VOID (renderer ${error.renderKind})`, expectedKinds === null || expectedKinds.includes(error.renderKind));
      return null;
    }
    if (error instanceof ReasoningRejectError) {
      row(group, check, `VOID (${error.rejectKind})`, expectedKinds === null || expectedKinds.includes(error.rejectKind));
      return null;
    }
    if (error instanceof Error) {
      row(group, check, `ERROR (${error.message})`, false);
      return null;
    }
    throw error;
  }
}

function certify(group, check, conclusion, { expectStatus = null, mustContain = [] } = {}) {
  let rendered;
  try {
    rendered = renderConclusion(conclusion);
  } catch (error) {
    row(group, check, `RENDER REFUSED (${error.renderKind ?? error.name})`, false, error.message);
    return null;
  }
  const scans = [];
  try {
    assertRendererVocabulary(rendered.statement.replace(/"[^"]*"/g, ""));
  } catch {
    scans.push("vocabulary guard tripped");
  }
  for (const fragment of mustContain) if (!rendered.statement.includes(fragment)) scans.push(`missing "${fragment}"`);
  const certificateOk = Boolean(
    rendered.attribution && rendered.windowKey && rendered.scopeIdentity
    && rendered.derivation.rule && rendered.derivation.refs.length > 0 && Object.isFrozen(rendered)
    && (expectStatus === null || rendered.epistemicStatus === expectStatus),
  );
  const pass = certificateOk && scans.length === 0;
  certifiedStatements.push({ group, statement: rendered.statement, attribution: rendered.attribution });
  row(group, check, `CERTIFIED status=${rendered.epistemicStatus} statement="${rendered.statement}"`, pass,
    pass ? "certificate carried" : scans.join("; "));
  return rendered;
}

/* ------------------------------- battery ---------------------------------- */

let child = null;
let pack;
try {
  child = await startLab();
  pack = await fetchPack();
} finally {
  if (child) child.kill("SIGKILL");
}

// ---- provenance & transport inventory (the contract actually transported it)
const ev = pack.evidence;
const counts = Object.fromEntries(
  ["facts", "observedSignals", "temporalSignals", "collectionFacts", "interpretations", "uncertainties", "explicitPreferences"]
    .map((k) => [k, ev[k].length]),
);
row("INGRESS", "real payload validates against the regenerated contract and normalizes verbatim",
  JSON.stringify(counts),
  counts.facts === 8 && counts.observedSignals === 2 && counts.temporalSignals === 1 && counts.collectionFacts === 1
    && counts.interpretations === 0 && counts.uncertainties === 0 && counts.explicitPreferences === 1);

const prov = ev.temporalSignals[0].provenance;
row("INGRESS", "real provenance arrives intact through the seam",
  `observationIds=${prov.observationIds.length} evidenceKeys=${prov.evidenceKeys.length} ingestionBatchIds=${JSON.stringify(prov.ingestionBatchIds)} eventOccurredAt=${prov.eventOccurredAt.length} observedAt=${prov.observedAt.length} scope=${prov.scopeIdentity}`,
  Array.isArray(prov.observationIds) && prov.observationIds.length === 3
    && Array.isArray(prov.evidenceKeys) && prov.evidenceKeys.length === 3
    && Array.isArray(prov.ingestionBatchIds) && Array.isArray(prov.eventOccurredAt)
    && prov.scopeIdentity === SCOPE);

row("INGRESS", "the surface carries its own constraints and they cross verbatim",
  JSON.stringify(ev.constraints),
  JSON.stringify(ev.constraints) === JSON.stringify([
    "Signals are observations, not likes or preferences",
    "No universal taste score",
    "No recommendation decision is made here",
  ]), "the producer tells the seam what is not licensed; preservation keeps that");

// ---- what the calculus may certify from real evidence
certify("DERIVE", "restate real observed fact (totalPlays)",
  restateEvidence(pack, { collection: "facts", index: 0 }, { window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectStatus: "observed", mustContain: ["3", '"totalPlays"'] });

certify("DERIVE", "restate real long-term signal with full provenance behind it",
  restateEvidence(pack, { collection: "observedSignals", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["totalWatches=3", '"behaviour-film"'] });

certify("DERIVE", "restate real temporal signal inside a caller-declared evidence window",
  restateEvidence(pack, { collection: "temporalSignals", index: 0 }, { window: WINDOW_90D, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["watchesLast90Days=2", "watchesLast30Days=1", "rolling_90d"] });

certify("DERIVE", "restate real collection fact",
  restateEvidence(pack, { collection: "collectionFacts", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["never_matched=3"] });

certify("DERIVE", "count the non-unknown facts as real arithmetic",
  aggregateEvidence(pack, [0, 1, 2, 3, 5, 6, 7].map((index) => ({ collection: "facts", index })),
    { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectStatus: "derived", mustContain: ["7 facts recorded"] });

certify("DERIVE", "sum real numeric facts",
  aggregateEvidence(pack, [{ collection: "facts", index: 0 }, { collection: "facts", index: 2 }],
    { mode: "sum", window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectStatus: "derived", mustContain: ["a total of 5 across 2 facts"] });

certify("DERIVE", "enumerate real subjects over both observed signals",
  aggregateEvidence(pack, [
    { collection: "observedSignals", index: 0 },
    { collection: "observedSignals", index: 1 },
  ], { mode: "subjects", window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["1 distinct subject", '"behaviour-film"'] });

certify("DERIVE", "unknown ground stays unknown on the REAL surface (hoursWatched = null value)",
  buildConclusion({
    kind: "absence_qualified", pack, rule: "qualify.v1",
    loadBearing: [{ collection: "facts", index: 4 }],
    scopeIdentity: "archive", window: WINDOW_ALL,
    claim: { open: "hours watched: duration evidence insufficient for a single number" },
  }),
  { expectStatus: "unknown", mustContain: ["remains open", "in this evidence delivery"] });

const detRule = { window: WINDOW_90D, scopeIdentity: SCOPE };
const detA = renderConclusion(restateEvidence(pack, { collection: "temporalSignals", index: 0 }, detRule));
const detB = renderConclusion(restateEvidence(pack, { collection: "temporalSignals", index: 0 }, detRule));
row("DERIVE", "real evidence replays byte-identically (no clocks in the calculus)",
  detA.statement === detB.statement ? "byte-stable" : "DRIFTED", detA.statement === detB.statement);

// ---- what stays VOID even with provenance-complete evidence
attemptVoid("VOID", "including an unknown fact in a positive aggregate kills the whole claim",
  () => aggregateEvidence(pack, ev.facts.map((_, index) => ({ collection: "facts", index })),
    { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" }), { expectedKinds: ["void_claim"] });

// ---- the resolved frontier: producer-declared window → bounded as-of claim
// (Owner verdict after the 3d7f104 experiment isolated the defect to the
// extractor's anchor vocabulary: extractWindow identifies the contract-typed
// value.window; identification, never reconstruction — no DAY_MS here.)
const producerWindow = CAPTURE.context.temporalSignals[0].value.window;
const asOfClaim = temporalClaim(pack, { collection: "temporalSignals", index: 0 });
const realSpanDays = (Date.parse(producerWindow.endsAt) - Date.parse(producerWindow.startsAt)) / 86_400_000;
row("DERIVE", "real producer-declared window licenses a bounded as-of claim (identification, not reconstruction)",
  `window=[${asOfClaim.claim.window.startsAt} .. ${asOfClaim.claim.window.endsAt}] asOf=${asOfClaim.claim.asOf} span=${realSpanDays}d status=${asOfClaim.epistemicStatus} rule=${asOfClaim.derivation.rule}`,
  asOfClaim.epistemicStatus === "derived"
    && asOfClaim.claim.window.startsAt === producerWindow.startsAt
    && asOfClaim.claim.window.endsAt === producerWindow.endsAt
    && asOfClaim.claim.asOf === CAPTURE.context.temporalSignals[0].derivedAt
    && asOfClaim.claim.asOf === producerWindow.endsAt // producer's own single-anchor invariant, crossing intact
    && realSpanDays === 90
    && asOfClaim.claim.metric.watchesLast90Days === 2,
  "the window arrived typed and declared upstream; the extractor copied the strings");

attemptVoid("VOID", "one real temporal signal cannot ground a trend",
  () => compareWindows(pack, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 0 }], { metricKey: "watchesLast90Days" }),
  { expectedKinds: ["lineage_incomplete", "void_claim"] });

attemptVoid("VOID", "real explicit preference statement is not handled enough to ground a conclusion",
  () => restateEvidence(pack, { collection: "explicitPreferences", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectedKinds: ["lineage_incomplete", "void_claim"] });

attemptVoid("VOID", "real interpretation channel is EMPTY: nothing to restate",
  () => restateEvidence(pack, { collection: "interpretations", index: 0 }, { window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectedKinds: ["bad_reference"] });

attemptVoid("VOID", "real uncertainty channel is EMPTY: the named-limit channel has no payload here",
  () => restateEvidence(pack, { collection: "uncertainties", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectedKinds: ["bad_reference"] });

// ---- contradiction behaviour over real evidence
const surfTotals = ["facts", "observedSignals", "temporalSignals", "collectionFacts", "interpretations", "uncertainties", "explicitPreferences"]
  .map((c) => [c, surfaceContradictions(pack, c).length]);
row("CONTRADICTION", "zero contradictions surfaced anywhere on real evidence (incl. the same-subject signal pair: identical lineage = one chain)",
  JSON.stringify(surfTotals), surfTotals.every(([, n]) => n === 0),
  "identical-lineage derivation is the exemption that fired on REAL data");

// -----------------------------------------------------------------------------
const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const passed = rows.filter((r) => r.pass).length;
const verdict = failures.length === 0 ? "PASS" : "FAIL";

const lines = [];
lines.push(`# Gate 7 — first real-evidence reasoning pass`);
lines.push(``);
lines.push(`> **Date:** 2026-09-19 · **Base commit:** \`${sha}\` · **Command:** \`node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-real-evidence-driver.mjs\` · **Verdict:** **${verdict}** (${passed}/${rows.length})`);
lines.push(`>`);
lines.push(`> **The question** (Gate 7's own, finally not hypothetical): given real`);
lines.push(`> provenance-backed evidence, what is Arena actually permitted to conclude?`);
lines.push(``);
lines.push(`## Evidence provenance`);
lines.push(``);
lines.push(`The payload at \`scripts/fixtures/real-evidence-upstream-capture.json\` is the`);
lines.push(`actual JSON upstream's runtime emitted — \`getPersonalisationContext()\` at`);
lines.push(`\`imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a\`,`);
lines.push(`seeded with the exact events of upstream's own regression test ("rebuilds`);
lines.push(`explainable recent, long-term, rewatch, scope, and explicit signals"), derived`);
lines.push(`as-of ${CAPTURE.derivedAt}. It is not a fixture Arena designed: Arena captured`);
lines.push(`it, validated it, and dropped it through the real seam (dev-replay HTTP server`);
lines.push(`→ read-only generated-operation client → generated-contract validation →`);
lines.push(`normalize → lattice → calculus → renderer).`);
lines.push(``);
lines.push(`## Checks`);
lines.push(``);
lines.push(`| # | Class | Check | Outcome |`);
lines.push(`|---|-------|-------|---------|`);
rows.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.group} | ${r.check} | ${r.pass ? "✅" : "❌"} ${r.outcome.replaceAll("|", "\\|")}${r.note ? ` — _${r.note.replaceAll("|", "\\|")}_` : ""} |`);
});
lines.push(``);
lines.push(`## Certified sentences (all of them)`);
lines.push(``);
for (const s of certifiedStatements) {
  lines.push(`- **[${s.group}]** “${s.statement}”  `);
  lines.push(`  ↳ \`${s.attribution}\``);
}
lines.push(``);
lines.push(`## What the calculus legitimately derives from real evidence`);
lines.push(``);
lines.push(`- **Restatements** carry real metrics inside real envelopes (watchesLast90Days=2,`);
lines.push(`  totalWatches=3, never_matched=3, totalPlays=3) with status, scope lineage,`);
lines.push(`  and an inspectable derivation — never upgraded, never paraphrased.`);
lines.push(`- **Aggregation arithmetic** over real facts: counts and sums over non-unknown`);
lines.push(`  membership (7 facts recorded; total of 5 across 2 facts; one distinct subject).`);
lines.push(`- **Unknown ground** on the real surface (hoursWatched = null value) yields an`);
lines.push(`  absence-qualified conclusion floored at \`unknown\` — open, scoped, never`);
lines.push(`  smoothed upward.`);
lines.push(`## The frontier that resolved in this slice`);
lines.push(``);
lines.push(`The first real-evidence pass (05742a3) found the temporal-window frontier:`);
lines.push(`the real surface expressed windows as coverage-era fields plus an untyped`);
lines.push(`comparisonWindowDays — nothing the 7.3 extractor could anchor on. The seam`);
lines.push(`investigation (docs/gate7-temporal-window-seam.md) ruled the meaning existed`);
lines.push(`producer-side but wasn't crossing the contract; the downstream experiment`);
lines.push(`(docs/gate7-temporal-window-experiment.md) then proved the meaning arrived`);
lines.push(`(contract-typed, required, single-anchored) while the extractor still could`);
lines.push(`not see it. The verdict: extractor branch, strictly additive. Row "real`);
lines.push(`producer-declared window licenses a bounded as-of claim" is the flip:`);
lines.push(`identification of value.window, bounds verbatim, span = the producer's own`);
lines.push(`90d, asOf = the evidence's own derivedAt (= window.endsAt, single anchor).`);
lines.push(`## What remains void even with provenance-complete evidence`);
lines.push(``);
lines.push(`- Any positive claim whose membership includes the unknown fact (void_claim).`);
lines.push(`- Trends (compareWindows): one real temporal signal cannot ground a comparison.`);
lines.push(`- The explicit-preference statement: its real provenance is`);
lines.push(`  \`{source:"operator statement"}\` — no lineage handles of any kind, so the`);
lines.push(`  lattice wall (lineage_incomplete) fires before any status question. The`);
lines.push(`  statement IS carried verbatim by transport; it cannot yet ground conclusions.`);
lines.push(`- Interpretations and uncertainties: channels exist in the contract but are`);
lines.push(`  EMPTY upstream today — nothing to restate or qualify against.`);
lines.push(`## Evidence classes still insufficient (the honest remainder)`);
lines.push(``);
lines.push(`1. **Preference-channel provenance** — explicit preference statements need`);
lines.push(`   handles (observationId / evidenceKey / observedAt family) before the lattice`);
lines.push(`   can ground anything on them; currently transport-only, correctly so.`);
lines.push(`2. **Interpretation & uncertainty payload** — upstream emits none today; the`);
lines.push(`   classes that carry "licensed inference" and "named limits" remain unfed.`);
lines.push(``);
lines.push(`*(Temporal window identity WAS class #1 here; it is resolved — see above.)*`);
lines.push(``);
if (failures.length) {
  lines.push(`## Failures`);
  for (const f of failures) lines.push(`- ${f}`);
  lines.push(``);
}

writeFileSync("docs/e2e-gate7-real-evidence.md", lines.join("\n"));
console.log(`Gate 7 · real-evidence pass: ${verdict} (${passed}/${rows.length})`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
