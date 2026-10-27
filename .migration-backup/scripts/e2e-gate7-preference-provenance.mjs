/**
 * e2e-gate7-preference-provenance.mjs — explicit-preference provenance
 * seam verification (upstream 1a2200bcbb496154f9ed9ede77059d6be9d0a1be,
 * "Add provenance identity for explicit preferences", atop base
 * 8e54a283c392c53f64099a903b293de220e565ce).
 *
 * Question: does the producer's closed preference provenance cross the
 * existing Archive Assistant → Arena seam verbatim — canonical AND
 * legacy — without Arena upgrading, relabelling, or re-handing it?
 *
 * Evidence: the real producer capture at
 * scripts/fixtures/real-evidence-upstream-capture.json — emitted by
 * upstream's own runtime at 1a2200b (getPersonalisationContext), seeded
 * with the verbatim upstream regression events plus one
 * recordExplicitPreference(observedAt explicit) and one legacy row
 * inserted exactly as upstream's own test seeds legacy (raw insert with
 * the pre-1a2200b provenance shape).
 *
 * Chain: capture → dev-replay HTTP (mock-personalisation-lab) → real
 * read-only client → generated-contract validation → Gate-6 normalize →
 * lattice/calculus (unchanged) → renderer. No new transport, no seventh
 * read, no Arena machinery changes; findings recorded, never patched.
 *
 * Writes docs/e2e-gate7-preference-provenance.md; exits non-zero on any
 * failed check.
 */

import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

import { createPersonalisationEvidenceClient } from "../src/lib/personalisation/client.ts";
import { normalizePersonalisationContext } from "../src/lib/personalisation/context.ts";
import { restateEvidence, aggregateEvidence } from "../src/lib/archive-reasoning/synthesizers.ts";
import { temporalClaim, compareWindows } from "../src/lib/archive-reasoning/temporal.ts";
import { surfaceContradictions } from "../src/lib/archive-reasoning/contradictions.ts";
import { ReasoningRejectError } from "../src/lib/archive-reasoning/lattice.ts";

const PORT = 4724;
const SCOPE = "plex:movies-v1";
const UPSTREAM_REF = "1a2200bcbb496154f9ed9ede77059d6be9d0a1be";

const CAPTURE = JSON.parse(readFileSync("scripts/fixtures/real-evidence-upstream-capture.json", "utf8"));

/* ------------------------------ harness ---------------------------------- */

function startLab() {
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/register-src-loader.mjs", "scripts/mock-personalisation-lab.mjs", String(PORT)],
    { env: { ...process.env, REAL_CAPTURE_FILE: "scripts/fixtures/real-evidence-upstream-capture.json", ADVERSARIAL_PERSONA: "" }, stdio: ["ignore", "pipe", "pipe"] },
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

/* ------------------------------ scorebook -------------------------------- */

const rows = [];
const failures = [];
function row(group, name, outcome, pass, note = "") {
  rows.push({ group, name, outcome, pass, note });
  if (!pass) failures.push(`[${group}] ${name} — ${outcome}${note ? ` (${note})` : ""}`);
}

function voidKind(fn) {
  try {
    const out = fn();
    return { certified: true, status: out.epistemicStatus ?? "?" };
  } catch (error) {
    return { certified: false, kind: error.rejectKind ?? error.constructor?.name ?? "error" };
  }
}

/* ------------------------------- battery --------------------------------- */

let child = null;
let wire;
let pack;
let packAgain;
try {
  child = await startLab();
  const client = createPersonalisationEvidenceClient(
    { baseUrl: `http://127.0.0.1:${PORT}`, authMode: "local", ownerId: "gate7-preference-provenance", timeoutMs: 4000 },
    { mode: "local", ownerId: "gate7-preference-provenance" },
  );
  wire = await client.getPersonalisationContext(); // contract-validated at ingress
  pack = normalizePersonalisationContext(wire);
  packAgain = normalizePersonalisationContext(JSON.parse(JSON.stringify(wire))); // determinism replay
} finally {
  if (child) child.kill("SIGKILL");
}

const canon = wire.explicitPreferences.find((p) => p.provenanceStatus === "authoritative");
const legacy = wire.explicitPreferences.find((p) => p.provenanceStatus === "legacy");
const packCanon = pack.evidence.explicitPreferences.find((p) => p.provenanceStatus === "authoritative");
const packLegacy = pack.evidence.explicitPreferences.find((p) => p.provenanceStatus === "legacy");
const PUBLIC = ["preferenceId", "subjectType", "subjectIdentity", "statement", "scopeIdentity", "observedAt", "provenanceStatus", "provenance"];

/* ---- canonical preference, field by field (verbatim across the boundary) ---- */
for (const key of PUBLIC) {
  row("CANONICAL", `${key} survives unchanged (wire → normalized pack)`,
    JSON.stringify(packCanon[key]),
    JSON.stringify(packCanon[key]) === JSON.stringify(canon[key]));
}
row("CANONICAL", "provenance shape closed: exactly {preferenceId, source, observedAt, scopeIdentity}",
  JSON.stringify(Object.keys(canon.provenance).sort()),
  Object.keys(canon.provenance).sort().join(",") === "observedAt,preferenceId,scopeIdentity,source"
    && canon.provenance.source === "operator_statement"
    && canon.provenance.preferenceId === canon.preferenceId
    && canon.provenance.observedAt === canon.observedAt
    && canon.provenance.scopeIdentity === canon.scopeIdentity);
const capturedCanon = CAPTURE.context.explicitPreferences.find((p) => p.provenanceStatus === "authoritative");
row("CANONICAL", "observedAt is the producer value, not capture/insertion time at read",
  `${canon.observedAt} (wire) === ${capturedCanon.observedAt} (capture, seeded 2026-09-18T12:00:00.000Z — yesterday, not now)`,
  canon.observedAt === capturedCanon.observedAt
    && canon.observedAt === canon.provenance.observedAt);

/* ---- identity & handling ---- */
row("IDENTITY", "no watch-event / behavioural identifiers substitute for preferenceId",
  Object.keys(canon.provenance).join(","),
  !/(eventId|observationId|evidenceKey|ingestionBatchId|batchId|refreshId)/i.test(JSON.stringify(canon.provenance).replaceAll("preferenceId", ""))
    && Number.isInteger(canon.preferenceId) && canon.preferenceId >= 1);
row("IDENTITY", "owner scoping rides the authenticated context; no owner field on the record or its provenance",
  `owner keys on record: ${Object.keys(canon).filter((k) => /owner/i.test(k)).join("") || "none"}`,
  !Object.keys(canon).some((k) => /owner/i.test(k)) && !Object.keys(canon.provenance).some((k) => /owner/i.test(k)));

/* ---- legacy row ---- */
row("LEGACY", "legacy row stays legacy across the seam (status verbatim)",
  `pack.provenanceStatus=${packLegacy.provenanceStatus}`,
  legacy.provenanceStatus === "legacy" && packLegacy.provenanceStatus === "legacy");
row("LEGACY", "legacy provenance === null verbatim — never replaced with a synthetic object",
  JSON.stringify(packLegacy.provenance),
  legacy.provenance === null && packLegacy.provenance === null);
row("LEGACY", "legacy fields still public payload (id/statement/scope preserved; never upgraded to canonical)",
  `preferenceId=${legacy.preferenceId} statement="${legacy.statement}" scope=${legacy.scopeIdentity}`,
  Number.isInteger(legacy.preferenceId)
    && JSON.stringify(packLegacy.subjectIdentity) === JSON.stringify(legacy.subjectIdentity)
    && packLegacy.provenanceStatus !== "authoritative");

/* ---- epistemic boundary: provenance establishes the statement, nothing else ---- */
const prefRef = { collection: "explicitPreferences", index: pack.evidence.explicitPreferences.indexOf(packCanon) };
const restate = voidKind(() => restateEvidence(pack, prefRef, { window: { label: "all_ingested" }, scopeIdentity: SCOPE }));
row("EPISTEMIC", "no conclusion forms from the preference's provenance under the unchanged calculus (recorded, not patched)",
  restate.certified ? `CERTIFIED status=${restate.status} (unexpected)` : `VOID (${restate.kind})`,
  restate.certified === false && restate.kind === "lineage_incomplete",
  "statement-level provenance is not behavioural lineage — lattice wall fires by design");
for (const [label, fn] of [
  ["as-of temporal claim", () => temporalClaim(pack, { collection: "explicitPreferences", index: pack.evidence.explicitPreferences.indexOf(packCanon) })],
  ["window comparison", () => compareWindows(pack, [prefRef, prefRef], { metricKey: "observedAt" })],
  ["positive aggregate", () => aggregateEvidence(pack, [prefRef], { mode: "count", window: { label: "all_ingested" }, scopeIdentity: SCOPE })],
]) {
  const outcome = voidKind(fn);
  row("EPISTEMIC", `${label}: refused — provenance does not license behavioural claims`,
    outcome.certified ? `CERTIFIED status=${outcome.status} (unexpected)` : `VOID (${outcome.kind})`,
    outcome.certified === false);
}
row("EPISTEMIC", "no contradiction surfaces treat the preference as behavioural evidence",
  JSON.stringify(surfaceContradictions(pack, "explicitPreferences").map((c) => c.kind)),
  surfaceContradictions(pack, "explicitPreferences").length === 0);

/* ---- determinism ---- */
row("DETERMINISM", "replay: normalized representation byte-identical (no wall-clock, no generated ids)",
  `explicitPreferences A===B: ${JSON.stringify(pack.evidence.explicitPreferences) === JSON.stringify(packAgain.evidence.explicitPreferences)}; full pack A===B: ${JSON.stringify(pack.evidence) === JSON.stringify(packAgain.evidence)}`,
  JSON.stringify(pack.evidence.explicitPreferences) === JSON.stringify(packAgain.evidence.explicitPreferences)
    && JSON.stringify(pack.evidence) === JSON.stringify(packAgain.evidence));

/* ------------------------------- ledger ---------------------------------- */

const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const passed = rows.filter((r) => r.pass).length;
const verdict = failures.length === 0 ? "PREFERENCE PROVENANCE VERIFIED" : "PREFERENCE PROVENANCE BLOCKED";

const lines = [];
lines.push(`# Gate 7 — explicit-preference provenance verification`);
lines.push(``);
lines.push(`> **Date:** 2026-09-19 · **Arena commit:** \`${sha}\` · **Upstream:** \`${UPSTREAM_REF}\``);
lines.push(`> ("Add provenance identity for explicit preferences", branch arena/01a0b5e9-somesafeportablesoftware,`);
lines.push(`> atop base 8e54a283c392c53f64099a903b293de220e565ce)`);
lines.push(`> **Command:** \`node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-preference-provenance.mjs\``);
lines.push(`> **Status:** **${verdict}** (${passed}/${rows.length} checks)`);
lines.push(``);
lines.push(`## Producer contract (verified from the tree at 1a2200b, not from reports)`);
lines.push(``);
lines.push(`- \`recordExplicitPreference()\` accepts NO caller provenance; it writes`);
lines.push(`  \`{preferenceId: row.id, source: "operator_statement", observedAt, scopeIdentity}\``);
lines.push(`  derived from the row itself — no response-time identifier, no watch-event`);
lines.push(`  identifiers anywhere in the shape.`);
lines.push(`- \`observedAt\` explicit input is preserved; omitted → insertion time.`);
lines.push(`- Read-time classification: a stored row is \`authoritative\` only when its`);
lines.push(`  stored provenance matches the row on all four fields; anything else — the`);
lines.push(`  pre-1a2200b shape, mismatches, tampering — is \`legacy\` with`);
lines.push(`  \`provenance: null\`, never silently upgraded.`);
lines.push(`- Owner isolation enforced by the authenticated owner query (per-owner DB`);
lines.push(`  select; owner identity appears nowhere on the emitted record).`);
lines.push(`- OpenAPI: items are typed \`PersonalisationExplicitPreference\``);
lines.push(`  (8 required fields) with closed \`PreferenceProvenance\``);
lines.push(`  (additionalProperties: false, source enum [operator_statement], nullable`); 
lines.push(`  oneOf); TS/Zod generated artifacts agree (checked: api.zod.ts,`);
lines.push(`  generated type files present for the two new schemas).`);
lines.push(``);
lines.push(`## Checks (real capture through the real seam)`);
lines.push(``);
lines.push(`| # | Group | Check | Outcome |`);
lines.push(`|---|-------|-------|---------|`);
rows.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.group} | ${r.name} | ${r.pass ? "✅" : "❌"} ${r.outcome.replaceAll("|", "\\|")}${r.note ? ` — _${r.note.replaceAll("|", "\\|")}_` : ""} |`);
});
lines.push(``);
lines.push(`## What the evidence licenses (and what it does not)`);
lines.push(``);
lines.push(`The provenance establishes exactly: **an identified explicit preference`);
lines.push(`statement with source, observation time, and scope.** It does not`);
lines.push(`establish observed/repeated behaviour, enjoyment, liking, taste,`);
lines.push(`recommendation suitability, interest, completion, or rewatch — and`);
lines.push(`under the unchanged calculus none of those form: the preference still`);
lines.push(`has no behavioural lineage handles, so the lattice wall refuses`);
lines.push(`(lineage_incomplete), which is the correct void under current rules.`);
lines.push(`No conclusion kind added; no preference-specific rule added; no taste`);
lines.push(`path added. Arena preserves and identifies; it does not upgrade.`);
if (failures.length) {
  lines.push(``, `## Failures`, ...failures.map((f) => `- ${f}`));
}
writeFileSync("docs/e2e-gate7-preference-provenance.md", lines.join("\n") + "\n");
console.log(`Gate 7 · preference provenance: ${verdict} (${passed}/${rows.length})`);
if (failures.length) process.exit(1);
