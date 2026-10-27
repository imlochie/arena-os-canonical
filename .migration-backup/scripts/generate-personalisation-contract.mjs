#!/usr/bin/env node
/**
 * generate-personalisation-contract.mjs
 *
 * Regenerates Arena's Gate-6 evidence-adapter contract from the upstream
 * Archive Assistant OpenAPI document (the single source of truth).
 *
 * Source of truth:
 *   SomeSafePortablesoftware → lib/api-spec/openapi.yaml
 *
 * Contract authority (locked by the owner, 2026-09-19 — Gate-5 re-verified
 * against the fetched tree, not a report; temporal-window re-verification
 * same day against the trees carrying upstream 141c789 + 3180bf9 and
 * then 4dcb2a0):
 *   repo    : imlochie/SomeSafePortablesoftware
 *   branch  : arena/01a0b5e9-somesafeportablesoftware
 *   commit  : 1a2200bcbb496154f9ed9ede77059d6be9d0a1be
 *             ("Add provenance identity for explicit preferences"):
 *             explicitPreferences items become typed
 *             PersonalisationExplicitPreference (preferenceId, subjectType,
 *             subjectIdentity, statement, scopeIdentity, observedAt,
 *             provenanceStatus [authoritative|legacy], provenance nullable)
 *             with a CLOSED PreferenceProvenance record (additionalProperties
 *             false; exactly preferenceId/source:operator_statement/
 *             observedAt/scopeIdentity); legacy rows carry
 *             provenanceStatus:"legacy", provenance:null — never upgraded.
 *             Supersedes 8e54a283c392c53f64099a903b293de220e565ce
 *             ("Emit separate previous temporal evidence row"):
 *             TemporalSignalValue.previousWindow becomes optional
 *             (required [window, previousWindow] -> [window]) as the
 *             producer now emits the previous observation as its own
 *             row, signalType "recent_activity_previous", parity key
 *             `watches`, per-row window, shared derivedAt anchor.
 *             Supersedes 4dcb2a0183bb5d5a9f59a3b8c8f24e71037d62c7
 *             ("Evolve archive temporal evidence to two windows"):
 *             TemporalSignalValue now REQUIRES [window, previousWindow] —
 *             current [now-90d, now], previous [now-180d, now-90d),
 *             half-open non-overlapping, one producer anchor, alongside
 *             watchesPrevious90Days / watchesLast90Days. Supersedes
 *             3180bf9bc63c1cf755c0725c2fd1336b2c360460 ("fix: anchor
 *             temporal signal derivation", window bounds from 141c789),
 *             itself superseding b5ca1647883cc06c9180015b07470a7880d1a56a
 *             ("test: verify provenance-backed evidence surface"), which
 *             superseded 0a971dd24ea73c21d5e54bda4ac486d394856702
 *             ("feat: publish archive personalisation evidence contract").
 *
 * Outputs (both AUTO-GENERATED — never hand-edit):
 *   src/lib/personalisation/generated/contract.ts  (operation + schemas snapshot)
 *   src/lib/personalisation/generated/types.ts     (TypeScript types)
 *
 * Usage:
 *   node scripts/generate-personalisation-contract.mjs [--spec <path-or-url>]
 *       [--ref <git-ref>] [--source-label <label>] [--check]
 *
 * Runs against the pinned commit by default — plain
 * `npm run generate:personalisation-contract` reproduces the committed
 * files byte-for-byte wherever raw.githubusercontent.com is reachable;
 * otherwise pass --spec <local copy of that ref's openapi.yaml>.
 *
 * All machinery lives in ./lib/openapi-contract-gen.mjs (shared with the
 * six-op read-only seam). This file only pins the seam configuration.
 */

import { runGenerator } from "./lib/openapi-contract-gen.mjs";

/** The Gate-6 seam: exactly one sanctioned read. Nothing outside this list
 *  is ever generated. This is the SEVENTH read — the bounded behavioural
 *  evidence context — and it stands beside the six-op operational bridge,
 *  not inside it. */
const PERSONALISATION_OPERATIONS = [
  { operationId: "getArchivePersonalisationContext", method: "get", path: "/assistant/personalisation-context" },
];

const TYPES_DOC = `/**
 * AUTO-GENERATED TypeScript types for the Archive Assistant
 * personalisation-evidence boundary (the Gate-6 seam). Mirrors the OpenAPI
 * component schemas referenced by the single sanctioned seventh read,
 * GET /assistant/personalisation-context. Regenerate; never hand-edit.
 */`;

const CONTRACT_DOC = `/**
 * AUTO-GENERATED machine-readable snapshot of the Archive Assistant
 * personalisation-evidence OpenAPI subset: the single sanctioned GET
 * operation (the seventh read) plus the transitive closure of its component
 * schemas. The Gate-6 adapter's runtime validator (../validate.ts) checks
 * every upstream response against this snapshot. Regenerate; never
 * hand-edit — and never substitute remembered architecture or the retired
 * Gen-1 bridge shapes for what this snapshot says.
 */`;

await runGenerator({
  operations: PERSONALISATION_OPERATIONS,
  boundaryNote: "the personalisation-evidence boundary",
  outDir: "src/lib/personalisation/generated",
  exportNames: {
    meta: "personalisationContractMeta",
    operations: "personalisationOperations",
    schemas: "personalisationSchemas",
  },
  npmCommand: "generate:personalisation-contract",
  typesDoc: TYPES_DOC,
  contractDoc: CONTRACT_DOC,
  defaults: {
    repo: "imlochie/SomeSafePortablesoftware",
    ref: "1a2200bcbb496154f9ed9ede77059d6be9d0a1be",
    sourceLabel:
      "https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0b5e9-somesafeportablesoftware/lib/api-spec/openapi.yaml",
    sourceRef:
      "imlochie/SomeSafePortablesoftware@1a2200bcbb496154f9ed9ede77059d6be9d0a1be",
  },
  checkName: "Archive Assistant personalisation contract",
});
