import "../waveyard/worker-local/_separation-test-env";
import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateResult } from "@workspace/arena/lib/runtime";
import { researchAnswer, type ResearchSource } from "./research";

const localSource: ResearchSource = {
  id: 1,
  title: "Saved note",
  snippet: "A locally stored note about the question.",
  origin: "archive",
};

test("research Local Mode suppresses web and model-provider requests and reports the actual fallback", async () => {
  let webSearches = 0;
  let remoteRequests = 0;

  const result = await researchAnswer(
    "What does my saved note say?",
    { modelId: "openai", keys: { openai: "should-not-be-used" }, localOnly: true },
    {
      gatherLocalSources: async () => [localSource],
      gatherWebSources: async () => { webSearches += 1; return []; },
      generateDeps: {
        fetchImpl: async () => {
          remoteRequests += 1;
          throw new Error("Remote provider request was attempted in Local Mode");
        },
      },
    },
  );

  assert.equal(webSearches, 0, "Local Mode must not attempt web research");
  assert.equal(remoteRequests, 0, "Local Mode must not attempt remote model generation");
  assert.equal(result.runtime.runtimeLevel, "arena-local");
  assert.equal(result.runtime.backend, "arena-local-engine");
  assert.equal(result.runtime.modelId, "local-engine");
  assert.equal(result.runtime.fallback, true);
  assert.equal(result.runtime.fallbackFrom?.backend, "pollinations");
  assert.match(result.answer, /deterministic offline engine/);
});

test("research preserves a real on-device model's runtime metadata", async () => {
  const actualExecution: GenerateResult = {
    text: "Device answer.",
    runtimeLevel: "on-device",
    backend: "local-server",
    provider: "local-server",
    modelId: "hub:ollama:qwen",
    requestedModelId: "hub:ollama:qwen",
    via: "local-server:127.0.0.1:11434/qwen",
    ms: 321,
    fallback: false,
  };

  const result = await researchAnswer(
    "Summarize my local source",
    { modelId: actualExecution.modelId, localOnly: true },
    {
      gatherLocalSources: async () => [localSource],
      generate: async () => actualExecution,
    },
  );

  assert.equal(result.runtime.runtimeLevel, "on-device");
  assert.equal(result.runtime.backend, "local-server");
  assert.equal(result.runtime.modelId, "hub:ollama:qwen");
  assert.equal(result.runtime.ms, 321);
  assert.equal(result.runtime.fallback, false);
});
