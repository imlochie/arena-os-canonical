/**
 * e2e-gate7-real-evidence-driver.mjs — the first REAL-EVIDENCE reasoning
 * pass. Gate 7's own question, finally not hypothetical:
 *
 *   Given real provenance-backed evidence, what is Arena actually
 *   permitted to conclude?
 *
 * The evidence is not a fixture invented for suspicion: it is the actual
 * JSON upstream's own runtime emitted at
 * imlochie/SomeSafePortablesoftware@8e54a283c392c53f64099a903b293de220e565ce
 * ("Emit separate previous temporal evidence row": value.window on each of
 * TWO rows — recent_activity + recent_activity_previous — parity key
 * `watches`, adjacent half-open non-overlapping spans, one producer anchor)
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
import { validatePersonalisationContract } from "../src/lib/personalisation/validate.ts";
import { extractWindow } from "../src/lib/archive-reasoning/windows.ts";

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
  const raw = await client.getPersonalisationContext();
  rawWire = JSON.parse(JSON.stringify(raw));
  return normalizePersonalisationContext(rawWire);
}

/** The validated-but-pre-normalization body, preserved exactly as
 *  received (mutated clones power the negative battery; certified rows
 *  only ever use the unmutated real pack). */
let rawWire = null;

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

/** The producer-declared windows on the single real temporal row (both
 *  REQUIRED at the contract since 141c789 / 4dcb2a0): current + previous,
 *  one anchor, half-open non-overlapping. Used by the certified row 14
 *  and the two-window verification section below. */
const currentWindow = CAPTURE.context.temporalSignals.find((s) => s.signalType === "recent_activity").value.window;
const previousWindow = CAPTURE.context.temporalSignals.find((s) => s.signalType === "recent_activity_previous").value.window;
const counts = Object.fromEntries(
  ["facts", "observedSignals", "temporalSignals", "collectionFacts", "interpretations", "uncertainties", "explicitPreferences"]
    .map((k) => [k, ev[k].length]),
);
row("INGRESS", "real payload validates against the regenerated contract and normalizes verbatim",
  JSON.stringify(counts),
  counts.facts === 8 && counts.observedSignals === 2 && counts.temporalSignals === 2 && counts.collectionFacts === 1
    && counts.interpretations === 0 && counts.uncertainties === 0 && counts.explicitPreferences === 2);

{
  const prov = ev.temporalSignals.find((s) => s.signalType === "recent_activity").provenance;
  row("INGRESS", "real provenance arrives intact through the seam (current row: its own 2 window events, not the whole history)",
    `observationIds=${prov.observationIds.length} evidenceKeys=${prov.evidenceKeys.length} ingestionBatchIds=${JSON.stringify(prov.ingestionBatchIds)} eventOccurredAt=${prov.eventOccurredAt.length} observedAt=${prov.observedAt.length} scope=${prov.scopeIdentity}`,
    Array.isArray(prov.observationIds) && prov.observationIds.length === 2
      && Array.isArray(prov.evidenceKeys) && prov.evidenceKeys.length === 2
      && Array.isArray(prov.ingestionBatchIds) && Array.isArray(prov.eventOccurredAt)
      && prov.scopeIdentity === SCOPE);
}
{
  const prevItem = ev.temporalSignals.find((s) => s.signalType === "recent_activity_previous");
  const currItem = ev.temporalSignals.find((s) => s.signalType === "recent_activity");
  const provPrev = prevItem.provenance;
  row("INGRESS", "previous row carries its own provenance chain (1 window event, same anchor, complete family)",
    `observationIds=${provPrev.observationIds.length} evidenceKeys=${provPrev.evidenceKeys.length} scope=${provPrev.scopeIdentity} derivedAt=${prevItem.derivedAt}`,
    Array.isArray(provPrev.observationIds) && provPrev.observationIds.length === 1
      && Array.isArray(provPrev.evidenceKeys) && provPrev.evidenceKeys.length === 1
      && provPrev.scopeIdentity === SCOPE
      && prevItem.derivedAt === currItem.derivedAt);
}

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
  { expectStatus: "observed", mustContain: ["4", '"totalPlays"'] });

certify("DERIVE", "restate real long-term signal with full provenance behind it",
  restateEvidence(pack, { collection: "observedSignals", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["totalWatches=4", '"behaviour-film"'] });

certify("DERIVE", "restate real temporal signal inside a caller-declared evidence window",
  restateEvidence(pack, { collection: "temporalSignals", index: 0 }, { window: WINDOW_90D, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["watchesLast90Days=2", "watchesLast30Days=1", "rolling_90d"] });

certify("DERIVE", "restate real collection fact",
  restateEvidence(pack, { collection: "collectionFacts", index: 0 }, { window: WINDOW_ALL, scopeIdentity: SCOPE }),
  { expectStatus: "derived", mustContain: ["never_matched=4"] });

certify("DERIVE", "count the non-unknown facts as real arithmetic",
  aggregateEvidence(pack, [0, 1, 2, 3, 5, 6, 7].map((index) => ({ collection: "facts", index })),
    { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectStatus: "derived", mustContain: ["7 facts recorded"] });

certify("DERIVE", "sum real numeric facts",
  aggregateEvidence(pack, [{ collection: "facts", index: 0 }, { collection: "facts", index: 2 }],
    { mode: "sum", window: WINDOW_ALL, scopeIdentity: "archive" }),
  { expectStatus: "derived", mustContain: ["a total of 7 across 2 facts"] });

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

/* ================= two-window verification (upstream 4dcb2a0) =================
 * Verification-only: do the producer's two declared windows let the
 * EXISTING calculus form a trend? Answered as a finding, not a patch. */

const currentItem = ev.temporalSignals.find((item) => item.signalType === "recent_activity");
const previousItem = ev.temporalSignals.find((item) => item.signalType === "recent_activity_previous");
const CUR = { collection: "temporalSignals", index: ev.temporalSignals.indexOf(currentItem) };
const PREV = { collection: "temporalSignals", index: ev.temporalSignals.indexOf(previousItem) };

/* -------- explicit-preference provenance seam (upstream 1a2200b) -------- */
const canonicalPref = rawWire.explicitPreferences.find((p) => p.provenanceStatus === "authoritative");
const legacyPref = rawWire.explicitPreferences.find((p) => p.provenanceStatus === "legacy");
const PACK_PREF_KEYS = ["preferenceId", "subjectType", "subjectIdentity", "statement", "scopeIdentity", "observedAt", "provenanceStatus", "provenance"];
function prefByStatus(collection, status) { return collection.find((p) => p.provenanceStatus === status); }
{
  const packCanon = prefByStatus(ev.explicitPreferences, "authoritative");
  const packLegacy = prefByStatus(ev.explicitPreferences, "legacy");
  const canonicalOk = PACK_PREF_KEYS.every((k) => JSON.stringify(packCanon[k]) === JSON.stringify(canonicalPref[k]))
    && Object.keys(packCanon).every((k) => PACK_PREF_KEYS.includes(k))
    && canonicalPref.provenance && Object.keys(canonicalPref.provenance).sort().join(",") === "observedAt,preferenceId,scopeIdentity,source"
    && canonicalPref.provenance.source === "operator_statement"
    && Number.isInteger(canonicalPref.preferenceId) && canonicalPref.provenance.preferenceId === canonicalPref.preferenceId
    && canonicalPref.provenance.observedAt === canonicalPref.observedAt
    && canonicalPref.provenance.scopeIdentity === canonicalPref.scopeIdentity;
  row("PREFERENCE", "canonical preference provenance crosses the seam verbatim (all 8 public fields; closed 4-key provenance attached)",
    `preferenceId=${canonicalPref.preferenceId} source=${canonicalPref.provenance?.source} observedAt=${canonicalPref.observedAt} scope=${canonicalPref.scopeIdentity} statement="${canonicalPref.statement}"`,
    Boolean(canonicalOk),
    "preferenceId / operator_statement / observedAt / scopeIdentity / subjectType / subjectIdentity / statement — no relabelling, no behavioural handles");
  const legacyOk = PACK_PREF_KEYS.every((k) => JSON.stringify(packLegacy[k]) === JSON.stringify(legacyPref[k]))
    && legacyPref.provenance === null && legacyPref.provenanceStatus === "legacy"
    && "preferenceId" in legacyPref && "statement" in legacyPref && legacyPref.scopeIdentity === canonicalPref.scopeIdentity;
  row("PREFERENCE", "legacy preference crosses as legacy: status + null, never replaced with a synthetic object",
    `provenanceStatus=${legacyPref.provenanceStatus} provenance=${JSON.stringify(legacyPref.provenance)} statement="${legacyPref.statement}" observedAt=${legacyPref.observedAt}`,
    Boolean(legacyOk), "null provenance preserved verbatim through transport and normalization");
  const wireProv = JSON.stringify(canonicalPref.provenance);
  const bodyProv = JSON.stringify(rawWire.explicitPreferences.find((p) => p.provenanceStatus === "authoritative").provenance);
  row("PREFERENCE", "preference provenance named only as preference provenance — no event/batch lineage attached, owner unexposed",
    `provenance.keys=${canonicalPref.provenance ? Object.keys(canonicalPref.provenance).join(",") : "none"}; owner-field present: ${"ownerId" in canonicalPref || "owner" in canonicalPref}`,
    wireProv === bodyProv
      && canonicalPref.provenance !== null
      && !("ownerId" in canonicalPref) && !("owner" in canonicalPref)
      && !/(eventId|observationId|evidenceKey|ingestionBatch|batchId|refreshId)/i.test(wireProv.replaceAll("preferenceId", "")),
    "statement-level provenance is not converted into behavioural provenance");
}

// (a) Extraction boundary, per row: each window identifies verbatim from
//     its own row's declaration; adjacency is read, not reconstructed.
const identifiedCurrent = extractWindow(currentItem);
const identifiedPrevious = extractWindow(previousItem);
row("EXTRACT", "two temporal rows: each extractor identifies its own window verbatim; adjacency prev.endsAt==curr.startsAt read, never reconstructed",
  `prev extracted=[${identifiedPrevious.startsAt} .. ${identifiedPrevious.endsAt}] | curr extracted=[${identifiedCurrent.startsAt} .. ${identifiedCurrent.endsAt}]`,
  !!identifiedCurrent && !!identifiedPrevious
    && identifiedCurrent.startsAt === currentWindow.startsAt && identifiedCurrent.endsAt === currentWindow.endsAt
    && identifiedPrevious.startsAt === previousWindow.startsAt && identifiedPrevious.endsAt === previousWindow.endsAt
    && previousWindow.endsAt === currentWindow.startsAt
    && currentItem.derivedAt === previousItem.derivedAt // one producer anchor, crossing intact
    && Number.isFinite(Date.parse(previousWindow.startsAt)),
  "identification only; nothing reconstructed from derivedAt or comparisonWindowDays");

// (b) The answering finding — what changed since 4dcb2a0: the semantics
//     did not have to change; the EVIDENCE ADDRESSING did. Two rows ⇒ two
//     refs ⇒ the pair is reachable by the unchanged members vocabulary.
const refsToPrevious = ev.temporalSignals.filter((item) => {
  const w = extractWindow(item);
  return w && w.startsAt === previousWindow.startsAt && w.endsAt === previousWindow.endsAt;
});
row("FINDING", "GAP CLOSED by producer emission (unchanged calculus): the previous observation now has its own ref — the pair is reachable vocabul",
  `temporalSignals=${ev.temporalSignals.length}; refs whose extracted window equals the declared previous window: ${refsToPrevious.length}`,
  ev.temporalSignals.length === 2 && refsToPrevious.length === 1
    && ev.temporalSignals.indexOf(refsToPrevious[0]) === PREV.index,
  "evidence unit moved from 1-row-2-windows to 2-rows-1-window-each; the addressing vocabulary was always sufficient");

// (c) The certified conclusion the whole Gate-7 exercise existed to earn:
//     the deterministic two-window comparison over real producer evidence.
const trend = compareWindows(pack, [CUR, PREV], { metricKey: "watches", scopeIdentity: SCOPE, rule: "temporal.compare.v1:watches" });
row("DERIVE", "certified two-window trend over REAL producer evidence: prev vs curr by the parity key, exact arithmetic",
  `perWindow=[prev@(${trend.claim.perWindow[0].window.startsAt} -> ${trend.claim.perWindow[0].value}), curr@(${trend.claim.perWindow[1].window.startsAt} -> ${trend.claim.perWindow[1].value})] delta=${trend.claim.comparisons[0].delta} relation=${trend.claim.comparisons[0].relation}`,
  trend.epistemicStatus === "derived"
    && trend.claim.perWindow.length === 2
    && trend.claim.perWindow[0].window.startsAt === previousWindow.startsAt // sorted prev-first by calculus
    && trend.claim.perWindow[0].window.endsAt === previousWindow.endsAt
    && trend.claim.perWindow[1].window.startsAt === currentWindow.startsAt
    && trend.claim.perWindow[1].window.endsAt === currentWindow.endsAt
    && trend.claim.perWindow[0].value === 1 && trend.claim.perWindow[1].value === 2
    && trend.claim.comparisons.length === 1
    && trend.claim.comparisons[0].delta === 1 && trend.claim.comparisons[0].relation === "greater"
    && trend.derivation.rule === "temporal.compare.v1:watches"
    && trend.scopeIdentity === SCOPE,
  "delta/relation are arithmetic over parity-key values; no adjective, no interpretation");

// (d) Its lineage: both rows load-bearing, envelope spans prev..curr,
//     and the double-run determinism of (b+ c) is asserted below.
const trendAgain = compareWindows(pack, [CUR, PREV], { metricKey: "watches", scopeIdentity: SCOPE, rule: "temporal.compare.v1:watches" });
row("DERIVE", "trend replays byte-identically (claim JSON stable across recomputation)",
  "claim-stable=" + (JSON.stringify(trend.claim) === JSON.stringify(trendAgain.claim)),
  JSON.stringify(trend.claim) === JSON.stringify(trendAgain.claim)
    && JSON.stringify(trend.derivation.loadBearing.map((r) => `${r.collection}:${r.index}`).sort()) === JSON.stringify(["temporalSignals:0", "temporalSignals:1"]),
  "textual, not aliasing: comparison is its own claim identity");

/* ------- negative battery: the two-window surface must not soften walls ------- */
function twinPack(mutate, metricMutation = true) {
  const wire = JSON.parse(JSON.stringify(rawWire));
  const twin = JSON.parse(JSON.stringify(rawWire.temporalSignals.find((s) => s.signalType === "recent_activity")));
  twin.signalId = "sig-neg-twin";
  twin.provenance = {
    ...twin.provenance,
    evidenceKeys: ["watch_observation:neg-twin"],
    providerEventIds: ["plex-evt-neg-twin"],
    observationIds: [77001],
    eventIds: [77001],
    batchIds: ["ing-neg-twin"],
    ingestionBatchIds: ["ing-neg-twin"],
  };
  if (metricMutation) { twin.value.watchesLast90Days = 6; twin.value.watches = 6; }
  mutate(twin);
  wire.temporalSignals.push(twin);
  return normalizePersonalisationContext(wire);
}
// The one place a second row may ARTIFACT from: synthetic twin mutation,
// mirroring real fields (driver-local, never shipped; serviced negative
// cases only).
function honestTwinWindow(startsAt, endsAt) {
  return { startsAt, endsAt };
}

// 1. overlapping windows refuse
attemptVoid("NEGATIVE", "overlapping windows still refuse a comparison",
  () => { const p = twinPack((t) => {
      const shifted = 30 * 86_400_000; // shifted −30d: overlaps the real row's window by construction
      t.value.window = honestTwinWindow(
        new Date(Date.parse(currentWindow.startsAt) - shifted).toISOString(),
        new Date(Date.parse(currentWindow.endsAt) - shifted).toISOString(),
      );
    }, false); return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["void_claim"] });

// 2. identical windows across two rows refuse (identity overlap)
attemptVoid("NEGATIVE", "identical windows across two rows refuse (identity overlap, never a trend out of a re-statement)",
  () => { const p = twinPack((t) => {
      t.value.window = honestTwinWindow(currentWindow.startsAt, currentWindow.endsAt);
    }); return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["void_claim"] });

// 3./4. window requiredness at the contract: window stays REQUIRED (8e54a28);
//     previousWindow is legacy-optional (its omission must be ACCEPTED, not
//     a hole: the previous observation is its own row now).
for (const [label, field, expect] of [["missing window", "window", false], ["missing previousWindow", "previousWindow", true]]) {
  const broken = JSON.parse(JSON.stringify(rawWire));
  delete broken.temporalSignals.find((s) => s.signalType === "recent_activity").value[field];
  const verdict = expect === false ? "the contract must refuse" : "the contract must accept (new producer shape)";
  try {
    validatePersonalisationContract("PersonalisationContext", broken);
    row("NEGATIVE", `${label} on a real row: ${verdict}`,
      expect ? `ACCEPTED at ingress (schema-required = [window] only)` : "validator ACCEPTED the broken payload", expect);
  } catch (error) {
    const message = String(error?.message ?? error);
    row("NEGATIVE", `${label} on a real row: ${verdict}`,
      expect ? `REFUSED at ingress (unexpected): ${message.slice(0, 120)}` : `REFUSED at ingress: ${message.slice(0, 120)}`,
      !expect && /ArchiveAssistantContractError$/.test(error?.constructor?.name ?? "") && message.includes(field));
  }
}

// 5. malformed bounds: string-typed, so the contract passes them; the
//    calculus semantic guard (parseable instants) refuses formation.
attemptVoid("NEGATIVE", "malformed bounds: contract types permit strings, calculus refuses formation downstream",
  () => { const p = twinPack((t) => {
      t.value.window = { startsAt: "not-an-instant", endsAt: "also-not-an-instant" };
      t.value.previousWindow = { startsAt: "not-an-instant", endsAt: "also-not-an-instant" };
    }); return temporalClaim(p, { collection: "temporalSignals", index: 2 }); },
  { expectedKinds: ["lineage_incomplete", "void_claim"] });

// 6. mismatched scopes across members
attemptVoid("NEGATIVE", "mismatched scopes across members refuse the comparison",
  () => { const p = twinPack((t) => {
      t.scopeIdentity = "plex:other-tenant";
      t.provenance = { ...t.provenance, scopeIdentity: "plex:other-tenant" };
    }); return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["void_claim", "lineage_incomplete", "mixed_class"] });

// 7. unknown (non-numeric) load-bearing metric kills the positive compare
attemptVoid("NEGATIVE", "unknown load-bearing metric refuses (no interpolation ever)",
  () => { const p = twinPack((t) => { t.value.watchesLast90Days = null; }, false);
    return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["void_claim"] });

// 8. missing lineage on a member refuses the conclusion (C4) — the twin
//    gets its own honest non-overlapping window first, so the flow truly
//    reaches the lineage check rather than refusing on overlap earlier.
attemptVoid("NEGATIVE", "missing lineage on a member refuses the conclusion",
  () => { const p = twinPack((t) => {
      t.provenance = {};
      t.value.window = honestTwinWindow(previousWindow.startsAt, previousWindow.endsAt);
    });
    return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["lineage_incomplete"] });

// 9. contradictory coverage-vs-producer window declarations refuse (never reconciled)
attemptVoid("NEGATIVE", "contradictory window declarations refuse (conflict propagates through comparison)",
  () => { const p = twinPack((t) => {
      t.coverage = { ...(t.coverage ?? {}), windowDays: 30 }; // coverage declares rolling_30d @ derivedAt, twin keeps the producer 90d span — conflict
    }); return compareWindows(p, [{ collection: "temporalSignals", index: 0 }, { collection: "temporalSignals", index: 2 }], { metricKey: "watchesLast90Days" }); },
  { expectedKinds: ["void_claim"] });

// 10. a single window is never a comparison
attemptVoid("NEGATIVE", "single-window temporal evidence refuses a comparison outright",
  () => compareWindows(pack, [{ collection: "temporalSignals", index: 0 }], { metricKey: "watchesLast90Days" }),
  { expectedKinds: ["lineage_incomplete"] });


// ---- what stays VOID even with provenance-complete evidence
attemptVoid("VOID", "including an unknown fact in a positive aggregate kills the whole claim",
  () => aggregateEvidence(pack, ev.facts.map((_, index) => ({ collection: "facts", index })),
    { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" }), { expectedKinds: ["void_claim"] });

// ---- the resolved frontier: producer-declared window → bounded as-of claim
// (Owner verdict after the 3d7f104 experiment isolated the defect to the
// extractor's anchor vocabulary: extractWindow identifies the contract-typed
// value.window; identification, never reconstruction — no DAY_MS here.)
const asOfClaim = temporalClaim(pack, { collection: "temporalSignals", index: 0 });
const currentSpanDays = (Date.parse(currentWindow.endsAt) - Date.parse(currentWindow.startsAt)) / 86_400_000;
row("DERIVE", "real producer-declared window licenses a bounded as-of claim (identification, not reconstruction)",
  `window=[${asOfClaim.claim.window.startsAt} .. ${asOfClaim.claim.window.endsAt}] asOf=${asOfClaim.claim.asOf} span=${currentSpanDays}d status=${asOfClaim.epistemicStatus} rule=${asOfClaim.derivation.rule}`,
  asOfClaim.epistemicStatus === "derived"
    && asOfClaim.claim.window.startsAt === currentWindow.startsAt
    && asOfClaim.claim.window.endsAt === currentWindow.endsAt
    && asOfClaim.claim.asOf === currentItem.derivedAt
    && asOfClaim.claim.asOf === currentWindow.endsAt // producer's own single-anchor invariant, crossing intact
    && currentSpanDays === 90
    && asOfClaim.claim.metric.watches === 2,
  "the window arrived typed and declared upstream; the extractor copied the strings");

// The within-one-row refusal is RETIRED (upstream 8e54a28): two real rows
// exist now — the positive path above is the same question, answered.
// (Old row: single-ref identity-overlap refusal — that case moves to the
// NEGATIVE battery as a twin construct, where it still must refuse.)
attemptVoid("VOID", "identity overlap still refuses as a negative construct (twin of one ref, never a pair from one row)",
  () => compareWindows(pack, [CUR, CUR], { metricKey: "watches" }),
  { expectedKinds: ["void_claim"] });

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
lines.push(`\`imlochie/SomeSafePortablesoftware@8e54a283c392c53f64099a903b293de220e565ce\`,`);
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
const trendRendered = renderConclusion(trend);
certifiedStatements.push({ group: "DERIVE", statement: trendRendered.statement, attribution: "temporal.compare.v1:watches" });
for (const s of certifiedStatements) {
  lines.push(`- **[${s.group}]** “${s.statement}”  `);
  lines.push(`  ↳ \`${s.attribution}\``);
}
lines.push(``);
lines.push(`## What the calculus legitimately derives from real evidence`);
lines.push(``);
lines.push(`- **Restatements** carry real metrics inside real envelopes (watchesLast90Days=2,`);
lines.push(`  totalWatches=4, never_matched=4, totalPlays=4) with status, scope lineage,`);
lines.push(`  and an inspectable derivation — never upgraded, never paraphrased.`);
lines.push(`- **Aggregation arithmetic** over real facts: counts and sums over non-unknown`);
lines.push(`  membership (7 facts recorded; total of 7 across 2 facts; one distinct subject).`);
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
lines.push(`- Trends (compareWindows) with fewer than two real temporal rows: singleton`);
lines.push(`- The explicit-preference statement: since 1a2200b it carries a closed`);
lines.push(`  canonical provenance (preferenceId / operator_statement / observedAt /`);
lines.push(`  scopeIdentity) — statement-level identity, NOT behavioural lineage`);
lines.push(`  handles — so the lattice wall (lineage_incomplete) still fires, by`);
lines.push(`  design, before any status question. The statement AND its provenance`);
lines.push(`  are carried verbatim by transport; neither yet grounds conclusions.`);
lines.push(`- Interpretations and uncertainties: channels exist in the contract but are`);
lines.push(`  EMPTY upstream today — nothing to restate or qualify against.`);
lines.push(`## Evidence classes still insufficient (the honest remainder)`);
lines.push(``);
lines.push(`1. **Preference-channel behavioural grounding** — upstream explicitly does`);
lines.push(`   NOT attach watch-event lineage handles to preferences (verified at`);
lines.push(`   1a2200b: no evidenceKey / observationId / eventId / ingestionBatchId on`);
lines.push(`   the preference record); under the existing lattice, therefore, no`);
lines.push(`   conclusion forms. Under current rules this is the correct void: a`);
lines.push(`   statement's identity is not evidence of behaviour.`);
lines.push(`2. **Interpretation & uncertainty payload** — upstream emits none today; the`);
lines.push(`   classes that carry "licensed inference" and "named limits" remain unfed.`);
lines.push(``);
lines.push(`*(Temporal window identity WAS class #1 here; it is resolved — see above.)*`);

lines.push(`## Two-window evidence (upstream 8e54a28): verification verdict`);
lines.push(``);
lines.push(`**VERIFIED.** The seam proposal (docs/gate7-two-window-seam-proposal.md)`);
lines.push(`landed upstream at \`8e54a283c392c53f64099a903b293de220e565ce\` ("Emit`);
lines.push(`separate previous temporal evidence row"): the previous observation is now`);
lines.push(`its own row (\`recent_activity_previous\`) with its own window, the parity`);
lines.push(`key \`watches\` on both rows, one producer anchor (\`derivedAt\` = current`);
lines.push(`window \`endsAt\`), rows emitted only for non-empty windows, per-row event`);
lines.push(`evidence. Historical record of the pre-landing verdict (SEMANTIC GAP at`);
lines.push(`4dcb2a0): docs/gate7-two-window-verification.md. On this capture, the`);
lines.push(`DERIVE rows show the full loop closing with zero Arena change: each window`);
lines.push(`identified verbatim from its own row (adjacent: \`prev.endsAt === curr.startsAt\`,`);
lines.push(`read, never reconstructed), the unchanged \`compareWindows("watches")\` pair`);
lines.push(`certifies \`delta=+1 / relation=\"greater\"\` (prev 1 → curr 2) with both rows`);
lines.push(`load-bearing, scope intact, envelope spanning prev→curr, byte-identical`);
lines.push(`replay, and the renderer speaking exactly the earned arithmetic. The`);
lines.push(`refusal class: retired as within-one-row (two real rows now); preserved`);
lines.push(`as the twin-construct negative, which still fails closed. No Arena`);
lines.push(`machinery, extractor, calculus, renderer, or conclusion-kind moved in this`);
lines.push(`slice — producer emission alone resolved the evidence unit.`);
lines.push(``);
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
