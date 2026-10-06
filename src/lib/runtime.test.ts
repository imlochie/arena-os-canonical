/**
 * AI Runtime contract tests (spec: three-tier refactor).
 *
 * The spec's guarantees, each under test:
 *   1. the catalog is tier-annotated and self-consistent;
 *   2. the Local Engine tier never lists brand models;
 *   3. legacy aliases resolve to the honest single engine;
 *   4. direct Local Engine selection is what it says it is;
 *   5. Local Mode + remote selection is a VISIBLE forced fallback;
 *   6. server-side WebLLM is an honest browser-only fallback;
 *   7. WebLLM with an injected executor really executes local-llm;
 *   8. TurboAgent failures fall back with the reason, never silently;
 *   9. a fully failed remote chain ends in a labelled offline fallback;
 *  10. a working remote route reports remote-free with no fallback;
 *  11. same-engine battles are refused before they start;
 *  12. post-execution same-engine detection + honest badge lines.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { generate } from "./ai";
import {
  FREE_MODELS,
  LOCAL_CANVAS_ID,
  LOCAL_ENGINE_ID,
  MODEL_ALIASES,
  getModel,
  type FreeModel,
} from "./models";
import {
  TIER_DESCRIPTIONS,
  TIER_LABELS,
  comparisonVerdict,
  executionsSameEngine,
  getRuntimeModel,
  localEngineResult,
  resolveModelId,
  runtimeBadge,
} from "./runtime";

const BRANDS = [
  "gpt",
  "mistral",
  "deepseek",
  "claude",
  "gemini",
  "llama",
  "qwen",
  "grok",
  "kimi",
  "forge",
  "chatgpt",
  "openai",
];

const msg = (content: string) => [{ role: "user" as const, content }];

// 1 ─────────────────────────────────────────────────────────────────────────
test("catalog: every model is tier-annotated and flags match its tier", () => {
  assert.ok(FREE_MODELS.length >= 10, "catalog is populated");
  for (const m of FREE_MODELS as FreeModel[]) {
    assert.ok(
      m.tier === "local-engine" || m.tier === "local-llm" || m.tier === "remote-free",
      `${m.id} has a known tier`,
    );
    assert.equal(typeof m.backend, "string", `${m.id} has a backend`);
    for (const flag of ["requiresNetwork", "requiresKey", "requiresDownload"] as const) {
      assert.equal(typeof m[flag], "boolean", `${m.id}.${flag} is a boolean`);
    }
    if (m.tier === "local-engine") {
      assert.equal(m.requiresNetwork, false, `${m.id}: local engine never needs network`);
      assert.equal(m.requiresKey, false, `${m.id}: local engine never needs a key`);
      assert.equal(m.requiresDownload, false, `${m.id}: local engine never needs a download`);
    }
    if (m.tier === "remote-free") assert.equal(m.requiresNetwork, true, `${m.id}: remote is network-honest`);
    if (m.backend === "webllm" || m.backend === "turboagent") assert.equal(m.tier, "local-llm", `${m.id}: local backends are local-llm tier`);
  }
});

// 2 ─────────────────────────────────────────────────────────────────────────
test("honesty: the Local Engine tier never lists brand models", () => {
  const localTier = FREE_MODELS.filter((m) => m.tier === "local-engine");
  assert.equal(localTier.length, 2, "exactly the engine + canvas");
  assert.equal(localTier[0].id, LOCAL_ENGINE_ID);
  assert.equal(localTier[1].id, LOCAL_CANVAS_ID);
  for (const m of localTier) {
    const haystack = `${m.name} ${m.provider} ${m.description ?? ""}`.toLowerCase();
    for (const brand of BRANDS) {
      assert.ok(!haystack.includes(brand), `${m.id} must not mention "${brand}"`);
    }
  }
  // …and the remote tier DOES carry real provider names (the trade is visible).
  const remote = FREE_MODELS.filter((m) => m.tier === "remote-free" && m.kind === "text");
  assert.ok(remote.length >= 5, "remote free tier lists real provider models");
});

// 3 ─────────────────────────────────────────────────────────────────────────
test("aliases: legacy ids resolve to the honest single engine", () => {
  assert.equal(MODEL_ALIASES["offline-sage"], LOCAL_ENGINE_ID);
  assert.equal(resolveModelId("offline-sage"), LOCAL_ENGINE_ID);
  assert.equal(resolveModelId("local-engine"), LOCAL_ENGINE_ID);
  assert.equal(resolveModelId("openai"), "openai", "non-aliases pass through");
  assert.equal(getRuntimeModel("offline-sage").id, LOCAL_ENGINE_ID);
  assert.equal(getRuntimeModel("offline-sage").backend, "arena-local-engine");
  // Unknown ids resolve to the honest default engine — and generate() would
  // report exactly that; the result can never claim a runtime that didn't run.
  assert.equal(getModel("no-such-model").id, LOCAL_ENGINE_ID);
});

// 4 ─────────────────────────────────────────────────────────────────────────
test("generate: direct Local Engine selection is exactly what it claims", async () => {
  const r = await generate({ modelId: "local-engine", messages: msg("What is a hashtable?") });
  assert.equal(r.runtimeTier, "local-engine");
  assert.equal(r.backend, "arena-local-engine");
  assert.equal(r.modelId, LOCAL_ENGINE_ID);
  assert.equal(r.via, "offline");
  assert.equal(r.fallback, false);
  assert.ok(!r.text.includes("Fallback:"), "no fallback notice when directly selected");
  assert.ok(r.ms >= 0);
});

// 5 ─────────────────────────────────────────────────────────────────────────
test("generate: Local Mode + remote selection is a VISIBLE forced fallback", async () => {
  const r = await generate({
    modelId: "openai",
    messages: msg("Explain RSA briefly"),
    localOnly: true,
    keys: { openrouter: "sk-or-v1-test" }, // keys must be ignored in Local Mode
  });
  assert.equal(r.runtimeTier, "local-engine");
  assert.equal(r.backend, "arena-local-engine");
  assert.equal(r.fallback, true);
  assert.equal(r.via, "offline-fallback");
  assert.deepEqual(r.fallbackFrom, { runtimeTier: "remote-free", backend: "pollinations", modelId: "openai" });
  assert.ok(r.text.includes("**Fallback: Local Engine**"), "fallback notice is visible in the text");
  assert.ok(r.text.includes("GPT"), "the notice names what was requested");
});

// 6 ─────────────────────────────────────────────────────────────────────────
test("generate: server-side WebLLM is an honest browser-only fallback", async () => {
  const r = await generate({ modelId: "webllm-qwen-coder-1.5b", messages: msg("write a function") });
  assert.equal(r.fallback, true);
  assert.equal(r.runtimeTier, "local-engine");
  assert.equal(r.fallbackFrom?.backend, "webllm");
  assert.ok(r.text.includes("browser"), "says WebLLM runs in the browser");
  assert.equal(r.note, "WebLLM is browser-only.");
});

// 7 ─────────────────────────────────────────────────────────────────────────
test("generate: WebLLM with an injected executor executes local-llm for real", async () => {
  const r = await generate(
    { modelId: "webllm-llama-3.2-3b", messages: msg("hello on device") },
    { webllmExecutor: async () => "on-device weights answered" },
  );
  assert.equal(r.runtimeTier, "local-llm");
  assert.equal(r.backend, "webllm");
  assert.equal(r.fallback, false);
  assert.equal(r.text, "on-device weights answered");
  assert.ok(r.via.startsWith("webllm:"));
});

// 8 ─────────────────────────────────────────────────────────────────────────
test("generate: TurboAgent failures fall back with the reason — never silently", async () => {
  const unconfigured = await generate({ modelId: "turboagent-7b", messages: msg("hi") });
  assert.equal(unconfigured.fallback, true);
  assert.ok(unconfigured.text.includes("no TurboAgent server configured"), "points at setup");

  const unreachable = await generate(
    { modelId: "turboagent-7b", messages: msg("hi"), keys: { turboagent: "http://127.0.0.1:9" } },
    { fetchImpl: (async () => {
      throw new Error("ECONNREFUSED simulated");
    }) as unknown as typeof fetch },
  );
  assert.equal(unreachable.fallback, true);
  assert.equal(unreachable.fallbackFrom?.backend, "turboagent");
  assert.ok(unreachable.text.includes("ECONNREFUSED simulated"), "carries the failure reason");
});

// 9 ─────────────────────────────────────────────────────────────────────────
test("generate: a fully failed remote chain ends in a labelled offline fallback", async () => {
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const r = await generate({ modelId: "deepseek", messages: msg("hello") }, { fetchImpl: failing });
  assert.equal(r.runtimeTier, "local-engine");
  assert.equal(r.via, "offline-fallback");
  assert.equal(r.fallback, true);
  assert.deepEqual(r.fallbackFrom, { runtimeTier: "remote-free", backend: "pollinations", modelId: "deepseek" });
  assert.ok(r.text.includes("**Fallback: Local Engine**"));
  assert.ok(r.text.includes("network down"), "records the last failure reason");
});

// 10 ────────────────────────────────────────────────────────────────────────
test("generate: a working remote route reports remote-free with no fallback", async () => {
  const okFetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "remote model answer" } }] }),
    }) as unknown as Response) as unknown as typeof fetch;
  const r = await generate({ modelId: "mistral", messages: msg("hello cloud") }, { fetchImpl: okFetch });
  assert.equal(r.runtimeTier, "remote-free");
  assert.equal(r.backend, "pollinations");
  assert.equal(r.modelId, "mistral");
  assert.equal(r.fallback, false);
  assert.equal(r.text, "remote model answer");
  assert.ok(!r.text.includes("Fallback:"));
});

// 11 ────────────────────────────────────────────────────────────────────────
test("battles: same-engine selections are refused before execution", () => {
  const bothEngine = comparisonVerdict("local-engine", "offline-sage"); // alias → same engine
  assert.equal(bothEngine.allowed, false);
  const engineVsRemote = comparisonVerdict("local-engine", "openai");
  assert.equal(engineVsRemote.allowed, true);
  const remoteVsRemote = comparisonVerdict("openai", "mistral");
  assert.equal(remoteVsRemote.allowed, true);
  const webllmVsEngine = comparisonVerdict("webllm-qwen-coder-1.5b", "local-engine");
  assert.equal(webllmVsEngine.allowed, true);
});

// 12 ────────────────────────────────────────────────────────────────────────
test("battles: post-execution same-engine detection and honest badges", () => {
  const a = localEngineResult("x", "offline-fallback", 5, { fallback: true });
  const b = localEngineResult("y", "offline", 5);
  assert.equal(executionsSameEngine(a, b), true, "both fell back to / ran the engine");
  const remote = { runtimeTier: "remote-free" as const, backend: "pollinations" as const, modelId: "openai", text: "", via: "", ms: 1, fallback: false };
  assert.equal(executionsSameEngine(a, remote), false);
  assert.equal(executionsSameEngine(a, null), false, "unknown execution is never claimed as same-engine");

  assert.equal(runtimeBadge(a), "🔒 Local Engine · no network");
  assert.ok(runtimeBadge(remote).startsWith("☁"), "remote results get the network badge");
  for (const tier of ["local-engine", "local-llm", "remote-free"] as const) {
    assert.ok(TIER_LABELS[tier].length > 0);
    assert.ok(TIER_DESCRIPTIONS[tier].length > 20, `${tier} has an honest description`);
  }
});
