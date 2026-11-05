import test from "node:test";
import assert from "node:assert/strict";
import { buildPong } from "./classics";
import { forgeGameWithAI, reviseImportedHtmlWithAI, testRemoteGameModel } from "./forge-ai";
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
  assert.match(request.messages[0].content, /If a control changes, update the control metadata/);
  assert.match(request.system, /check every listed key and touch action against the event handlers/);
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

test("local Model Hub generation stays on the selected model with remote fallback disabled", async () => {
  const modelId = "hub:ollama:qwen2.5-3b";
  const signal = new AbortController().signal;
  let request: any;
  const result = await forgeGameWithAI("A tiny game that collects one coin", {
    modelId,
    localOnly: true,
    signal,
  }, {
    generate: (async (input: any) => {
      request = input;
      return { text: buildPong(), modelId, backend: "local-server", via: "local-server:127.0.0.1/ollama", fallback: false, ms: 3 };
    }) as any,
  });

  assert.equal(result.validation.ok, true);
  assert.equal(request.modelId, modelId);
  assert.equal(request.localOnly, true);
  assert.equal(request.keys, undefined);
  assert.equal(request.allowPublicFallback, false);
  assert.equal(request.signal, signal);
});

test("remote model test sends only a fixed small request through the selected provider", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let request: any;
  const result = await testRemoteGameModel("deepseek", { signal }, {
    generate: (async (input: any) => {
      request = input;
      return {
        text: "Draw a player, move with arrows, and score by collecting stars.",
        runtimeLevel: "remote",
        backend: "pollinations",
        modelId: "deepseek",
        via: "pollinations:deepseek",
        fallback: false,
        ms: 12,
      };
    }) as any,
  });

  assert.equal(request.modelId, "deepseek");
  assert.deepEqual(request.messages, [{
    role: "user",
    content: "For a tiny HTML5 game, name one thing to draw, one key control, and one way to score. Reply in one short sentence.",
  }]);
  assert.equal(request.signal, signal);
  assert.equal(request.strictRoute, true);
  assert.equal(request.allowPublicFallback, false);
  assert.equal(request.maxTokens, 48);
  assert.equal(request.keys, undefined);
  assert.equal(result.runtime.backend, "pollinations");
  assert.equal(result.runtime.modelId, "deepseek");
});

test("remote model test rejects local selections and provider fallback results", async () => {
  let called = false;
  await assert.rejects(
    () => testRemoteGameModel("turboagent-32b", {}, {
      generate: (async () => { called = true; throw new Error("must not run"); }) as any,
    }),
    /not a supported remote text model/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => testRemoteGameModel("deepseek", {}, {
      generate: (async () => ({
        text: "fallback text",
        runtimeLevel: "arena-local",
        backend: "arena-local-engine",
        modelId: "offline-sage",
        via: "offline-fallback",
        fallback: true,
        ms: 1,
      })) as any,
    }),
    /no fallback was accepted/,
  );
});

test("oversized revision source is refused before calling a model", async () => {
  let called = false;
  await assert.rejects(() => forgeGameWithAI("add a level", { priorCode: "x".repeat(50_001) }, {
    generate: (async () => { called = true; throw new Error("must not run"); }) as any,
  }), /too large to revise/);
  assert.equal(called, false);
});

test("imported-game revisions pass cancellation to the selected model", async () => {
  const controller = new AbortController();
  const source = buildPong();
  let request: any;
  const pending = reviseImportedHtmlWithAI(
    "Add a pause overlay",
    source,
    { modelId: "hub:ollama:qwen2.5-3b", localOnly: true, signal: controller.signal },
    {
      generate: (async (input: any) => {
        request = input;
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }) as any,
    },
  );
  assert.equal(request.signal, controller.signal);
  assert.equal(request.modelId, "hub:ollama:qwen2.5-3b");
  assert.equal(request.localOnly, true);
  assert.equal(request.keys, undefined);
  assert.equal(request.allowPublicFallback, false);
  controller.abort();
  await assert.rejects(pending, (error: any) => error.name === "AbortError");
});
