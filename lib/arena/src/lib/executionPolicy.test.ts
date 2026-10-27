import assert from "node:assert/strict";
import test from "node:test";
import { enforceExecutionPolicy, evaluateWorkerEligibility } from "./executionPolicy";
import { resolveWorkforceAssignments, type AvailableWorker } from "./workforceResolver";

const workers: AvailableWorker[] = [
  {
    id: "model:remote", modelId: "claude", name: "Remote", provider: "remote",
    capabilities: ["Analysis"], available: true, localCapable: false, remoteCapable: true,
    supportsStructuredOutput: true, availability: "available", overallElo: 1500, categoryElo: { reasoning: 1500 },
  },
  {
    id: "model:local", modelId: "offline-sage", name: "Local", provider: "local",
    capabilities: ["Offline"], available: true, localCapable: true, remoteCapable: false, supportsStructuredOutput: true, availability: "available",
    overallElo: 1100, categoryElo: { reasoning: 1100 },
  },
];

const request = [{ slot: "perspective_a", requestedRole: "Critic", workforceRoleId: "critic" }];

test("online permits local and remote workers", () => {
  const decisions = evaluateWorkerEligibility(workers, "online");
  assert.deepEqual(decisions.map((decision) => decision.eligible), [true, true]);
});

for (const mode of ["offline", "local_only"] as const) {
  test(`${mode} excludes remote-only workers before ranking`, () => {
    const policy = enforceExecutionPolicy(workers, mode);
    assert.deepEqual(policy.eligibleWorkers.map((worker) => worker.modelId), ["offline-sage"]);
    const [assignment] = resolveWorkforceAssignments(request, policy.eligibleWorkers, {
      executionMode: mode, eligibilityReasons: policy.eligibilityReasons,
    });
    assert.equal(assignment.modelId, "offline-sage");
    assert.equal(assignment.executionMode, mode);
    assert.match(assignment.eligibilityDecision, /permits local-capable/);
  });
}

test("a remote pinned worker fails explicitly under offline policy", () => {
  assert.throws(
    () => enforceExecutionPolicy(workers, "offline", ["claude"]),
    (error: any) => error.code === "NO_ELIGIBLE_WORKER" && /prohibits remote-only/.test(error.reason)
  );
});

test("ranking remains deterministic after policy eligibility filtering", () => {
  const policy = enforceExecutionPolicy(workers, "online");
  const first = resolveWorkforceAssignments(request, policy.eligibleWorkers, {
    executionMode: "online", eligibilityReasons: policy.eligibilityReasons,
  });
  const second = resolveWorkforceAssignments(request, policy.eligibleWorkers, {
    executionMode: "online", eligibilityReasons: policy.eligibilityReasons,
  });
  assert.deepEqual(first, second);
  assert.equal(first[0].modelId, "claude");
});
