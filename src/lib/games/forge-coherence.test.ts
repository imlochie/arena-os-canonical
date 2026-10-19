import test from "node:test";
import assert from "node:assert/strict";
import { detectGameType, generateGameOffline } from "./index";
import { forgeGameWithAI } from "./forge-ai";
import type { generate } from "@/lib/ai";

const novelRequests = [
  "a turn based railway logistics puzzle with cargo contracts",
  "a space trading economy with fuel and docking",
  "a ghost photography game where exposure determines the score",
];

for (const prompt of novelRequests) {
  test(`unknown mechanics never silently become a template: ${prompt}`, () => {
    assert.equal(detectGameType(prompt), null);
    assert.throws(() => generateGameOffline(prompt), /No offline template matches/);
  });
}

test("explicit offline template selection remains usable", () => {
  const g = generateGameOffline("blue theme", "arena");
  assert.equal(g.gameType, "arena");
  assert.ok(g.code.includes("requestAnimationFrame"));
});

// These exercise orchestration with a controlled model, not real model quality.
function responder(text: string, inspect?: (input: Parameters<typeof generate>[0]) => void): typeof generate {
  return (async (input) => {
    inspect?.(input);
    return { text, modelId: "test-code-model", backend: "groq", runtimeLevel: "remote", via: "test", ms: 1, fallback: false };
  }) as typeof generate;
}

test("iteration sends the existing full game and instruction to the model", async () => {
  const prior = generateGameOffline("snake").code;
  const modified = generateGameOffline("snake with wrap").code;
  const result = await forgeGameWithAI("add wraparound at the edges", { priorCode: prior }, {
    generate: responder(modified, (input) => {
      assert.ok(input.messages[0].content.includes(prior));
      assert.ok(input.messages[0].content.includes("add wraparound at the edges"));
    }),
  });
  assert.equal(result.code, modified);
  assert.equal(result.engine, "ai-codegen");
  assert.equal(result.gameType, "custom");
});

test("model fallback is failure, not a template success", async () => {
  const generateFallback = (async () => ({ fallback: true, text: "local prose", ms: 1, modelId: "arena-local", backend: "arena-local-engine", runtimeLevel: "arena-local", via: "test" })) as typeof generate;
  await assert.rejects(forgeGameWithAI(novelRequests[0], {}, { generate: generateFallback }), /no capable model/);
});

test("repair includes the failed draft, not just a fresh game request", async () => {
  const valid = generateGameOffline("snake").code;
  const invalid = valid.replaceAll("requestAnimationFrame", "badLoop");
  let calls = 0;
  const gen = (async (input) => {
    calls++;
    if (calls === 2) assert.ok(input.messages[0].content.includes(invalid));
    return { text: calls === 1 ? invalid : valid, modelId: "test", backend: "groq", runtimeLevel: "remote", via: "test", ms: 1, fallback: false };
  }) as typeof generate;
  const result = await forgeGameWithAI(novelRequests[0], {}, { generate: gen });
  assert.equal(result.repairsUsed, 1);
  assert.equal(result.code, valid);
});

test("a failed repair cannot be presented as successful generation", async () => {
  const invalid = generateGameOffline("snake").code.replaceAll("requestAnimationFrame", "badLoop");
  let calls = 0;
  const gen: typeof generate = async () => ({
    text: ++calls === 1 ? invalid : "deterministic fallback",
    modelId: "test", backend: "groq", runtimeLevel: "remote", via: "test", ms: 1,
    fallback: calls > 1,
  });
  await assert.rejects(forgeGameWithAI(novelRequests[0], {}, { generate: gen }), /Repair model unavailable/);
});

test("repair cannot claim AI codegen after a Local Engine response even if fallback flag is false", async () => {
  const valid = generateGameOffline("snake").code;
  const invalid = valid.replaceAll("requestAnimationFrame", "badLoop");
  let calls = 0;
  const gen = (async () => ({ text: ++calls === 1 ? invalid : valid, backend: calls === 1 ? "groq" : "arena-local-engine", modelId: "controlled", runtimeLevel: "remote", via: "test", ms: 1, fallback: false })) as typeof generate;
  await assert.rejects(forgeGameWithAI("custom mechanics", {}, { generate: gen }), /Repair model unavailable/);
});
test("failed validation retains an inspectable draft without presenting it as a playable game", async () => {
  const invalid = generateGameOffline("snake").code.replaceAll("requestAnimationFrame", "badLoop");
  await assert.rejects(forgeGameWithAI("custom mechanics", {}, { generate: responder(invalid) }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const failure = error as Error & { draft?: { code: string; validation: { ok: boolean }; runtime: { modelId: string } } };
    assert.equal(failure.draft?.code, invalid);
    assert.equal(failure.draft?.validation.ok, false);
    assert.equal(failure.draft?.runtime.modelId, "test-code-model");
    return true;
  });
});

test("retry explicitly supplies the useful failed draft and checkpoints it before any repair request", async () => {
  const partial = "<!doctype html><html><canvas></canvas><script>// unfinished exposure mechanic 🎵";
  const valid = generateGameOffline("snake").code;
  let checkpointed = false, calls = 0;
  const gen = (async (input) => {
    calls++;
    if(calls===1) { assert.ok(input.messages[0].content.includes(partial)); return { text: partial, modelId:"controlled-fixture",backend:"groq",runtimeLevel:"remote",via:"controlled-not-inference",ms:1,fallback:false }; }
    assert.equal(checkpointed,true); return {text:valid,modelId:"controlled-fixture",backend:"groq",runtimeLevel:"remote",via:"controlled-not-inference",ms:1,fallback:false};
  }) as typeof generate;
  const result=await forgeGameWithAI("requested exposure game",{failedDraftCode:partial,onDraft:async draft=>{if(!checkpointed)assert.equal(draft.code,partial);checkpointed=true;}},{generate:gen});
  assert.equal(result.code,valid);assert.equal(calls,2);
});
