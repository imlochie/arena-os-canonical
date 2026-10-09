import assert from "node:assert/strict";
import test from "node:test";
import { enforceWorkerSuitability } from "./workerSuitability";
import { resolveWorkforceAssignments, type AvailableWorker, type WorkforceRequest } from "./workforceResolver";

const base = (overrides: Partial<AvailableWorker>): AvailableWorker => ({
  id: "worker:base", modelId: "base", name: "Base", provider: "provider",
  capabilities: [], available: true, localCapable: false, remoteCapable: true,
  supportsStructuredOutput: false, availability: "unknown", overallElo: 1200,
  categoryElo: { reasoning: 1200 }, ...overrides,
});

const synthesis: WorkforceRequest = {
  slot: "synthesis", requestedRole: "Synthesizer", workforceRoleId: "researcher",
  requiredCapabilities: ["structured_output"],
};

test("structured synthesis excludes workers without structured-output capability", () => {
  const workers = [
    base({ id: "worker:plain", modelId: "plain", overallElo: 1600 }),
    base({ id: "worker:structured", modelId: "structured", supportsStructuredOutput: true, overallElo: 1100 }),
  ];
  const suitability = enforceWorkerSuitability(workers, [synthesis]);
  assert.deepEqual(suitability.eligibleWorkersBySlot.get("synthesis")?.map((worker) => worker.modelId), ["structured"]);
});

test("unavailable workers are excluded while unknown remains eligible", () => {
  const workers = [
    base({ id: "worker:down", modelId: "down", availability: "unavailable", supportsStructuredOutput: true }),
    base({ id: "worker:unknown", modelId: "unknown", availability: "unknown", supportsStructuredOutput: true }),
  ];
  const suitability = enforceWorkerSuitability(workers, [synthesis]);
  assert.deepEqual(suitability.eligibleWorkersBySlot.get("synthesis")?.map((worker) => worker.modelId), ["unknown"]);
});

test("capability and health filtering remain separate from deterministic ranking", () => {
  const workers = [
    base({ id: "worker:a", modelId: "openai", availability: "available", supportsStructuredOutput: true, overallElo: 1300 }),
    base({ id: "worker:b", modelId: "deepseek", availability: "available", supportsStructuredOutput: true, overallElo: 1400 }),
  ];
  const suitability = enforceWorkerSuitability(workers, [synthesis]);
  const options = {
    eligibleWorkersBySlot: suitability.eligibleWorkersBySlot,
    suitabilityReasons: suitability.suitabilityReasons,
  };
  const first = resolveWorkforceAssignments([synthesis], workers, options);
  const second = resolveWorkforceAssignments([synthesis], workers, options);
  assert.deepEqual(first, second);
  assert.equal(first[0].modelId, "deepseek");
  assert.equal(first[0].workerAvailability, "available");
  assert.deepEqual(first[0].capabilitiesConsidered, ["structured_output"]);
  assert.match(first[0].eligibilityDecision, /availability confirmed/);
});

test("a pinned incapable or unavailable worker fails explicitly", () => {
  const workers = [base({ id: "worker:plain", modelId: "plain", availability: "unavailable", supportsStructuredOutput: true })];
  assert.throws(
    () => enforceWorkerSuitability(workers, [{ ...synthesis, pinnedModelId: "plain" }]),
    (error: any) => error.code === "NO_ELIGIBLE_WORKER" && /unavailable/.test(error.reason)
  );
});
