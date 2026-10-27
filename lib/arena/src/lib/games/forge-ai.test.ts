import test from "node:test";
import assert from "node:assert/strict";
import { buildPong } from "./classics";
import { forgeGameWithAI } from "./forge-ai";
import { isClassicCorePrompt } from "./index";

test("classic titles inside custom requests never select a preset core", () => {
  assert.equal(isClassicCorePrompt("Pong"), true);
  assert.equal(isClassicCorePrompt("Make a snake game"), true);
  assert.equal(isClassicCorePrompt("Pong with weapons and moving walls"), false);
  assert.equal(isClassicCorePrompt("Space Invaders with a persistent open world"), false);
  assert.equal(isClassicCorePrompt("Mario"), false);
});

test("a model revision receives the existing game source instead of rebuilding a preset", async () => {
  const existing = buildPong();
  const revised = buildPong({ accent: "#ff9955" });
  let request: any;
  const result = await forgeGameWithAI("Change the paddle glow to orange", { priorCode: existing }, {
    generate: (async (input: any) => {
      request = input;
      return { text: revised, modelId: "test-code-model", backend: "openrouter", via: "test", fallback: false, ms: 1 };
    }) as any,
  });
  assert.equal(result.code, revised);
  assert.equal(result.engine, "ai-codegen");
  assert.match(request.messages[0].content, /Modify the existing game/);
  assert.match(request.messages[0].content, /Change the paddle glow to orange/);
  assert(request.messages[0].content.includes(existing));
  assert.equal(request.allowPublicFallback, false);
});

test("a deterministic fallback is not accepted as arbitrary game generation", async () => {
  await assert.rejects(() => forgeGameWithAI("A platform game with wall jumps", {}, {
    generate: (async () => ({
      text: buildPong(), modelId: "local-engine", backend: "arena-local-engine", via: "test", fallback: true, ms: 1,
    })) as any,
  }), (error: any) => error.noModel === true);
});

test("oversized revision source is refused before calling a model", async () => {
  let called = false;
  await assert.rejects(() => forgeGameWithAI("add a level", { priorCode: "x".repeat(50_001) }, {
    generate: (async () => { called = true; throw new Error("must not run"); }) as any,
  }), /too large to revise/);
  assert.equal(called, false);
});
