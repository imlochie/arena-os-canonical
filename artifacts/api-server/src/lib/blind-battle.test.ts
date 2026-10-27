import assert from "node:assert/strict";
import test from "node:test";
import { publicBattlePayload } from "./blind-battle";

const runtime = {
  modelId: "local-engine", requestedModelId: "secret-model",
  backend: "arena-local-engine", provider: "arena", via: "secret-provider",
  runtimeLevel: "arena-local", ms: 12, fallback: true,
  fallbackFrom: { runtimeLevel: "remote", backend: "private-provider", modelId: "secret-model" },
  fallbackReason: "secret-model unavailable", note: "secret-model failed",
};
test("unvoted records remove nested identity and preserve execution status", () => {
  const original = { winner: null, modelAId: "secret-model", modelBId: "other-model", assistantAId: "secret-assistant", runtimeA: runtime };
  const result = publicBattlePayload({ battles: [original] }).battles[0];
  assert.equal(result.modelAId, "???");
  assert.equal(result.assistantAId, null);
  assert.equal(result.runtimeA.runtimeLevel, "arena-local");
  assert.equal(result.runtimeA.fallback, true);
  assert.equal(result.runtimeA.ms, 12);
  assert(!JSON.stringify(result).includes("secret"));
  assert.equal(original.runtimeA.modelId, "local-engine", "Stored diagnostics must not be mutated");
});
test("creation and SSE payloads are blind even without a winner property", () => {
  const result = publicBattlePayload({
    type: "battle", battle: { runtimeA: runtime, viaA: "secret-provider", createdAt: new Date("2026-01-01T00:00:00Z") },
  }, true);
  assert(!JSON.stringify(result).includes("secret"));
  assert.equal(result.battle.createdAt, "2026-01-01T00:00:00.000Z");
});
test("voted records retain full diagnostics and model identities", () => {
  const battle = { winner: "a", modelAId: "secret-model", modelBId: "other-model", runtimeA: runtime };
  assert.deepEqual(publicBattlePayload(battle), battle);
});
