import test from "node:test";
import assert from "node:assert/strict";
import { missionEvidence, type EvidenceAction } from "./mission-evidence";
const report = (actions: EvidenceAction[]) => missionEvidence({ journal: [{ actions }], artifacts: [] });
test("model completion or command success is not passing tests", () => {
  assert.equal(report([]).testCommandSuccesses, 0);
  const result = report([{ tool: "run_command", ok: true, provenance: "executed" }]);
  assert.equal(result.commandSuccesses, 1); assert.equal(result.testCommandSuccesses, 0);
});
test("only qualified machine test outcomes count, not human review, legacy observations or uncertainty", () => {
  const result = report([
    { tool: "run_tests", ok: true, provenance: "human-reconciliation" },
    { tool: "run_tests", ok: true, provenance: "observation" },
    { tool: "run_tests", ok: true },
    { tool: "run_tests", ok: true, provenance: "executed", uncertain: true },
    { tool: "run_tests", ok: true, provenance: "executed" },
    { tool: "run_tests", ok: false, provenance: "approval-ledger" },
  ]);
  assert.equal(result.testCommandSuccesses, 1); assert.equal(result.testCommandFailures, 1);
  assert.equal(result.humanReviewed, 1); assert.equal(result.uncertain, 1);
});
test("repeat observations of the same request do not double-count a recovered outcome", () => {
  const result = report([
    { tool: "run_tests", ok: false, requestId: "one", provenance: "observation" },
    { tool: "run_tests", ok: true, requestId: "one", provenance: "approval-ledger" },
  ]);
  assert.equal(result.toolOutcomes, 1); assert.equal(result.testCommandSuccesses, 1); assert.equal(result.testCommandFailures, 0);
});
test("an output path or claimed success is not an immutable deliverable", () => {
  const result = missionEvidence({ journal: [], artifacts: [
    { state: "complete" },
    { state: "unavailable", artifactId: "a", revisionId: "r", checksumSha256: "a".repeat(64) },
    { state: "complete", artifactId: "a", revisionId: "r", checksumSha256: "not-a-hash" },
    { state: "complete", artifactId: "a", revisionId: "r", checksumSha256: "b".repeat(64) },
  ] });
  assert.equal(result.immutableOutputs, 1); assert.equal(result.unavailableOutputs, 1);
});
