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
 * against the fetched tree, not a report):
 *   repo    : imlochie/SomeSafePortablesoftware
 *   branch  : arena/01a0b5e9-somesafeportablesoftware
 *   commit  : b5ca1647883cc06c9180015b07470a7880d1a56a
 *             ("test: verify provenance-backed evidence surface"; provenance
 *             enforcement landed at 0489d2c, "feat: enforce archive observation
 *             provenance") on the same pinned branch, superseding
 *             0a971dd24ea73c21d5e54bda4ac486d394856702 ("feat: publish archive
 *             personalisation evidence contract").
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
    ref: "b5ca1647883cc06c9180015b07470a7880d1a56a",
    sourceLabel:
      "https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0b5e9-somesafeportablesoftware/lib/api-spec/openapi.yaml",
    sourceRef:
      "imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a",
  },
  checkName: "Archive Assistant personalisation contract",
});
