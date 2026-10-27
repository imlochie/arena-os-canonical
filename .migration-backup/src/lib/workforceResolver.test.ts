import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkforceAssignments, type AvailableWorker } from "./workforceResolver";

const workers: AvailableWorker[] = [
  {
    id: "model:openai", modelId: "openai", name: "Forge GPT", provider: "provider-a",
    capabilities: ["General", "Reasoning"], available: true, localCapable: false, remoteCapable: true, supportsStructuredOutput: true, availability: "available", overallElo: 1300,
    categoryElo: { reasoning: 1400, general: 1350 },
  },
  {
    id: "model:claude", modelId: "claude", name: "Claude Forge", provider: "provider-b",
    capabilities: ["Analysis", "Writing"], available: true, localCapable: false, remoteCapable: true, supportsStructuredOutput: true, availability: "available", overallElo: 1320,
    categoryElo: { reasoning: 1450, general: 1280 },
  },
  {
    id: "model:deepseek", modelId: "deepseek", name: "DeepSeek Forge", provider: "provider-c",
    capabilities: ["Reasoning", "Coding"], available: false, localCapable: false, remoteCapable: true, supportsStructuredOutput: true, availability: "available", overallElo: 1500,
    categoryElo: { reasoning: 1600 },
  },
];

test("deterministically resolves a requested role to the best available preferred worker", () => {
  const [assignment] = resolveWorkforceAssignments([{
    slot: "perspective_b",
    requestedRole: "Socratic Inquisitor",
    workforceRoleId: "critic",
  }], workers);
  assert.equal(assignment.modelId, "claude");
  assert.equal(assignment.workerId, "model:claude");
  assert.equal(assignment.provider, "provider-b");
  assert.equal(assignment.executionMode, "online");
  assert.match(assignment.selectionReason, /highest reasoning rating/);
  assert.ok(assignment.capabilityMatch.includes("role:critic"));
});

test("explicit model selection is treated as an explainable session constraint", () => {
  const [assignment] = resolveWorkforceAssignments([{
    slot: "synthesis",
    requestedRole: "Research Synthesizer",
    workforceRoleId: "researcher",
    pinnedModelId: "openai",
  }], workers);
  assert.equal(assignment.modelId, "openai");
  assert.match(assignment.selectionReason, /explicit session constraint/);
});

test("never assigns unavailable workers and rejects unavailable pinned constraints", () => {
  const [assignment] = resolveWorkforceAssignments([{
    slot: "perspective_a",
    requestedRole: "Field Researcher",
    workforceRoleId: "researcher",
  }], workers);
  assert.notEqual(assignment.modelId, "deepseek");
  assert.throws(() => resolveWorkforceAssignments([{
    slot: "perspective_a",
    requestedRole: "Field Researcher",
    workforceRoleId: "researcher",
    pinnedModelId: "deepseek",
  }], workers), /unavailable/);
});

test("fails explicitly when no execution resource is available", () => {
  assert.throws(() => resolveWorkforceAssignments([{
    slot: "perspective_a",
    requestedRole: "Architect",
    workforceRoleId: "architect",
  }], workers.map((worker) => ({ ...worker, available: false }))), /no Workforce workers available/);
});

test("Arena-style allocations can require distinct workers when alternatives exist", () => {
  const assignments = resolveWorkforceAssignments([
    { slot: "fighter_a", requestedRole: "A", workforceRoleId: "critic" },
    { slot: "fighter_b", requestedRole: "B", workforceRoleId: "critic" },
  ], workers.filter((worker) => worker.available), { distinctWorkers: true });
  assert.notEqual(assignments[0].workerId, assignments[1].workerId);
});
