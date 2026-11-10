import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { GenerateResult } from "@workspace/arena/lib/runtime";

// An unreachable database puts the mission store in its memory mode, which is
// what these planning tests need; the module refuses to load with no URL at all.
process.env.DATABASE_URL ??= "postgres://arena:arena@127.0.0.1:1/arena";
const { runMission, getLatestMission } = await import("./mission");
const { workspaceDir } = await import("./tools");

const done = (over: Partial<GenerateResult> = {}): GenerateResult => ({
  text: JSON.stringify({ actions: [], done: true }),
  runtimeLevel: "remote", backend: "groq" as GenerateResult["backend"], provider: "Groq",
  modelId: "served", via: "test", ms: 0, fallback: false, ...over,
});

async function run(spaceId: string, deps: Parameters<typeof runMission>[2], opts: Parameters<typeof runMission>[1] = {}) {
  try {
    return await runMission(spaceId, { goal: "exercise planning", isolation: "host", ...opts }, deps);
  } finally {
    await rm(workspaceDir(spaceId), { recursive: true, force: true });
  }
}

test("a fresh default mission routes every role through the Space's selected model and records what ran", async () => {
  const id = randomUUID();
  const selected = "groq/llama-3.3-70b-versatile";
  const dispatched: string[] = [];
  const mission = await run(id, {
    loadFleet: async () => [],
    loadSpaceModel: async () => selected,
    generate: async (input) => {
      dispatched.push(input.modelId);
      return done({
        requestedModelId: selected, backend: "arena-local-engine" as GenerateResult["backend"], provider: "Arena",
        runtimeLevel: "arena-local" as GenerateResult["runtimeLevel"], modelId: "local-engine", fallback: true,
        fallbackFrom: { runtimeLevel: "remote", backend: "groq", modelId: selected } as GenerateResult["fallbackFrom"],
        fallbackReason: "Provider key is not configured.",
      });
    },
  });
  assert.deepEqual(dispatched.slice(0, 1), [selected]);
  assert.ok(mission.agentPlan.every((agent) => agent.modelId === selected));
  const step = mission.journal[0];
  assert.equal(step?.runtime?.agentModelId, selected);
  assert.equal(step?.runtime?.modelId, "local-engine");
  assert.equal(step?.runtime?.fallback, true);
  assert.equal(step?.runtime?.fallbackReason, "Provider key is not configured.");
  assert.equal(step?.runtime?.fallbackFrom?.modelId, selected);
});

test("a configured fleet drives routing and outranks the Space model", async () => {
  const id = randomUUID();
  const fleet = [
    { name: "Planner", role: "plan", modelId: "groq/planner" },
    { name: "Builder", role: "implement", modelId: "openrouter/builder" },
  ];
  const routed: string[] = [];
  const mission = await run(id, {
    loadFleet: async () => fleet,
    loadSpaceModel: async () => { throw new Error("must not be consulted when a fleet exists"); },
    generate: async (input) => { routed.push(input.modelId); return done(); },
  });
  assert.deepEqual(mission.agentPlan.map((agent) => agent.modelId), fleet.map((agent) => agent.modelId));
  assert.equal(routed[0], "groq/planner");
});

test("an unreadable fleet stops before any mission is created or provider is called", async () => {
  const id = randomUUID();
  let providerCalls = 0;
  await assert.rejects(
    run(id, {
      loadFleet: async () => { throw new Error("configured fleet could not be read"); },
      generate: async () => { providerCalls += 1; return done(); },
    }),
    /configured fleet could not be read/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(await getLatestMission(id), null);
});

test("an explicit per-mission plan is honoured without reading the fleet", async () => {
  const id = randomUUID();
  const mission = await run(id, {
    loadFleet: async () => { throw new Error("fleet must not be read"); },
    generate: async () => done({ requestedModelId: "openrouter/user-selected" }),
  }, { agentPlan: [{ name: "Override", role: "override", modelId: "openrouter/user-selected" }] });
  assert.deepEqual(mission.agentPlan.map((agent) => agent.modelId), ["openrouter/user-selected"]);
  assert.equal(mission.journal[0]?.runtime?.fallback, false);
});
