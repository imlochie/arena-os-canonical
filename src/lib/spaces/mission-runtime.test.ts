import test from "node:test";
import assert from "node:assert/strict";
import type { GenerateResult } from "@/lib/runtime";
import { observeMissionRuntime } from "./mission-runtime";

test("mission records the actual provider/model and preserves fallback provenance", () => {
  const result: GenerateResult = {
    text: "local fallback output",
    runtimeLevel: "arena-local",
    provider: "arena",
    backend: "arena-local-engine",
    modelId: "local-engine",
    requestedModelId: "groq/llama-3.3-70b-versatile",
    via: "offline-fallback",
    ms: 2,
    fallback: true,
    fallbackFrom: { runtimeLevel: "remote", backend: "groq", modelId: "groq/llama-3.3-70b-versatile" },
    fallbackReason: "Provider key is not configured.",
  };
  assert.deepEqual(observeMissionRuntime(result, "groq/llama-3.3-70b-versatile"), {
    agentModelId: "groq/llama-3.3-70b-versatile",
    requestedModelId: "groq/llama-3.3-70b-versatile",
    runtimeLevel: "arena-local",
    provider: "arena",
    backend: "arena-local-engine",
    modelId: "local-engine",
    via: "offline-fallback",
    fallback: true,
    fallbackFrom: { runtimeLevel: "remote", backend: "groq", modelId: "groq/llama-3.3-70b-versatile" },
    fallbackReason: "Provider key is not configured.",
  });
});

test("a successful generation records its actual execution without implying fallback", () => {
  const result: GenerateResult = {
    text: "remote output",
    runtimeLevel: "remote",
    provider: "Groq",
    backend: "groq",
    modelId: "llama-3.3-70b-versatile",
    requestedModelId: "groq/llama-3.3-70b-versatile",
    via: "groq",
    ms: 20,
    fallback: false,
  };
  const observed = observeMissionRuntime(result, "groq/llama-3.3-70b-versatile");
  assert.equal(observed.modelId, "llama-3.3-70b-versatile");
  assert.equal(observed.backend, "groq");
  assert.equal(observed.provider, "Groq");
  assert.equal(observed.fallback, false);
  assert.equal("fallbackReason" in observed, false);
});
