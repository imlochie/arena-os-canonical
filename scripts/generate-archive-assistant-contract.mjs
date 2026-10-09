#!/usr/bin/env node
/**
 * generate-archive-assistant-contract.mjs
 *
 * Regenerates Arena's read-only Archive Assistant contract from the upstream
 * Archive Assistant OpenAPI document (the single source of truth).
 *
 * Source of truth:
 *   SomeSafePortablesoftware → lib/api-spec/openapi.yaml
 *
 * Outputs (both AUTO-GENERATED — never hand-edit):
 *   src/lib/archive-assistant/generated/contract.ts  (operations + schemas snapshot)
 *   src/lib/archive-assistant/generated/types.ts     (TypeScript types)
 *
 * Usage:
 *   node scripts/generate-archive-assistant-contract.mjs [--spec <path-or-url>]
 *       [--ref <git-ref>] [--source-label <label>] [--check]
 *
 *   --spec   Local path or http(s) URL of openapi.yaml.
 *            Default: raw GitHub URL built from --repo + --ref.
 *   --repo   Upstream repo (default: imlochie/SomeSafePortablesoftware).
 *   --ref    Git ref of the upstream spec (default: main).
 *            NOTE: the read-only assistant boundary lands on main via the
 *            branch arena/01a0a0d9-somesafeportablesoftware. The committed
 *            snapshot was generated from that branch; once it merges, plain
 *            `--ref main` reproduces it.
 *   --check  Do not write files; fail if committed output is stale.
 *
 * All machinery lives in ./lib/openapi-contract-gen.mjs (shared with the
 * Gate-6 personalisation seam). This file only pins the seam configuration.
 */

import { runGenerator } from "./lib/openapi-contract-gen.mjs";

/** The official read-only seam. Nothing outside this list is ever generated,
 *  keeping mutation/control-plane surface out of Arena by construction. */
const READ_ONLY_OPERATIONS = [
  { operationId: "getAssistantOverview", method: "get", path: "/assistant/overview" },
  { operationId: "getAssistantWorkload", method: "get", path: "/assistant/workload" },
  { operationId: "getArchiveReconciliation", method: "get", path: "/archive/reconciliation" },
  { operationId: "getReconciliationFindingLineage", method: "get", path: "/archive/reconciliation/findings/{reviewItemId}/lineage" },
  { operationId: "getProviderRefreshState", method: "get", path: "/provider/refresh" },
  { operationId: "listProviderRefreshHistory", method: "get", path: "/provider/refresh/history" },
];

const TYPES_DOC = `/**
 * AUTO-GENERATED TypeScript types for the Archive Assistant read-only boundary.
 * Mirrors the OpenAPI component schemas referenced by the six sanctioned
 * read-only operations. Regenerate; never hand-edit.
 */`;

const CONTRACT_DOC = `/**
 * AUTO-GENERATED machine-readable snapshot of the Archive Assistant read-only
 * OpenAPI subset: the six sanctioned GET operations plus the transitive
 * closure of their component schemas. The runtime validator
 * (../validate.ts) checks every upstream response against this snapshot.
 * Regenerate; never hand-edit.
 */`;

await runGenerator({
  operations: READ_ONLY_OPERATIONS,
  boundaryNote: "the read-only assistant boundary",
  outDir: "src/lib/archive-assistant/generated",
  exportNames: {
    meta: "archiveContractMeta",
    operations: "archiveReadOnlyOperations",
    schemas: "archiveSchemas",
  },
  npmCommand: "generate:archive-contract",
  typesDoc: TYPES_DOC,
  contractDoc: CONTRACT_DOC,
  defaults: {
    repo: "imlochie/SomeSafePortablesoftware",
    ref: "main",
  },
  checkName: "Archive Assistant contract",
});
