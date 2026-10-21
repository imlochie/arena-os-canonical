import test from "node:test";
import assert from "node:assert/strict";
import { selectMissionPlan } from "./mission-plan.ts";

const agent = (name: string, modelId: string) => ({ name, role: "worker", modelId });

test("fresh default roles use the model selected on the space", () => {
  const selected = "groq/llama-3.3-70b-versatile";
  const plan = selectMissionPlan({ fleet: [], spaceModel: selected });
  assert.deepEqual(plan.map(({ name, modelId }) => [name, modelId]), [
    ["Planner", selected], ["Builder", selected], ["Reviewer", selected],
  ]);
});

test("explicit and fleet plans keep precedence over the space default", () => {
  const explicit = [agent("Explicit", "user-selected-agent-model")];
  const fleet = [agent("Fleet", "fleet-model")];
  assert.deepEqual(selectMissionPlan({ explicitPlan: explicit, fleet, spaceModel: "space-model" }), explicit);
  assert.deepEqual(selectMissionPlan({ fleet, spaceModel: "space-model" }), fleet);
});

test("resumed missions retain their persisted plan, and missing space model keeps legacy default", () => {
  const saved = [agent("Saved checkpoint agent", "pinned-checkpoint-model")];
  assert.deepEqual(selectMissionPlan({ resumingPlan: saved, explicitPlan: [agent("New", "new-model")], fleet: [], spaceModel: "changed-space-model" }), saved);
  assert.ok(selectMissionPlan({ fleet: [] }).every(({ modelId }) => modelId === "openai"));
});
