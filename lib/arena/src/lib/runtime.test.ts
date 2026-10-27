/**
 * AI Runtime contract tests — the multi-level Arena spec.
 *
 * Levels (HOW an answer is produced, not intelligence ranking):
 *   LEVEL 0 "arena-local" — deterministic offline engine (NOT an LLM), baseline
 *   LEVEL 1 "on-device"   — real model inference on the user's machine
 *   LEVEL 2 "remote"      — real provider-backed inference over the network
 *
 * The 20 spec points, each under test (20 = the production build, verified in
 * CI/verification runs, not assertable in-process):
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
  LEVEL_DESCRIPTIONS,
  LEVEL_LABELS,
  LEVEL_NUMBER,
  comparisonVerdict,
  executionsSameEngine,
  battleRateable,
  getRuntimeModel,
  localEngineResult,
  poweredBy,
  resolveModelId,
  runtimeBadge,
  describeRuntimeModel,
} from "./runtime";
import { probeRuntimeStatus } from "./runtimeStatus";

const BRANDS = [
  "gpt", "mistral", "deepseek", "claude", "gemini", "llama",
  "qwen", "grok", "kimi", "forge", "chatgpt", "openai",
];

const msg = (content: string) => [{ role: "user" as const, content }];

/** A fetch that records calls and can be programmed to fail. */
function countingFetch(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    calls.push(String(url));
    if (opts.fail) throw new Error("network down");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "mock answer" } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// 1 ─────────────────────────────────────────────────────────────────────────
test("level 0: Arena Local Engine is available without any configuration", async () => {
  const r = await generate({ modelId: "local-engine", messages: msg("What is a hashtable?") });
  assert.equal(r.runtimeLevel, "arena-local");
  assert.equal(r.backend, "arena-local-engine");
  assert.equal(r.modelId, LOCAL_ENGINE_ID);
  assert.equal(r.via, "offline");
  assert.equal(r.fallback, false);
  assert.equal(r.ms >= 0, true);
  assert.ok(!r.text.includes("Fallback:"), "no fallback notice when directly selected");
});

// 2 + 18 ───────────────────────────────────────────────────────────────────
test("level 0 + strict local mode: zero network calls (fetch never invoked)", async () => {
  const direct = countingFetch();
  await generate({ modelId: "local-engine", messages: msg("hi") }, { fetchImpl: direct.impl });
  assert.equal(direct.calls.length, 0, "direct local-engine selection never calls fetch");

  const strict = countingFetch();
  const r = await generate(
    { modelId: "openai", messages: msg("hi"), localOnly: true, keys: { openrouter: "sk-or-v1-x" } },
    { fetchImpl: strict.impl },
  );
  assert.equal(strict.calls.length, 0, "local mode makes no network calls even with a remote selection + keys");
  assert.equal(r.fallback, true);
  assert.equal(r.runtimeLevel, "arena-local");
  assert.equal(r.via, "offline-fallback");
});

// 3 ─────────────────────────────────────────────────────────────────────────
test("level 0: never reported as an LLM", async () => {
  const r = await generate({ modelId: "local-engine", messages: msg("hi") });
  assert.equal(r.runtimeLevel, "arena-local");
  const info = describeRuntimeModel(getModel("local-engine"));
  assert.equal(info.qualityExpectation, "Not model intelligence — heuristic templates");
  assert.equal(LEVEL_LABELS["arena-local"], "Arena Local Engine");
  assert.ok(LEVEL_DESCRIPTIONS["arena-local"].includes("Not an LLM"), "level description says it is not an LLM");
  assert.ok(runtimeBadge(r).includes("LEVEL 0"));
  assert.equal(LEVEL_NUMBER["arena-local"], 0);
});

// 4 + 16 ───────────────────────────────────────────────────────────────────
test("no fake model ID can disguise the Local Engine as a different model", async () => {
  assert.equal(MODEL_ALIASES["offline-sage"], LOCAL_ENGINE_ID);
  assert.equal(resolveModelId("offline-sage"), LOCAL_ENGINE_ID);
  const r = await generate({ modelId: "offline-sage", messages: msg("hi") });
  assert.equal(r.modelId, LOCAL_ENGINE_ID, "alias execution reports the real engine id");
  assert.equal(r.requestedModelId, "offline-sage", "…and what was requested is preserved");
  assert.equal(getRuntimeModel("offline-sage").backend, "arena-local-engine");
  // The catalog has exactly ONE local engine text entry + one canvas entry.
  const locals = FREE_MODELS.filter((m) => m.level === "arena-local");
  assert.deepEqual(locals.map((m) => m.id).sort(), [LOCAL_CANVAS_ID, LOCAL_ENGINE_ID].sort());
  for (const m of locals) {
    const haystack = `${m.name} ${m.provider} ${m.description ?? ""}`.toLowerCase();
    for (const brand of BRANDS) assert.ok(!haystack.includes(brand), `${m.id} must not mention "${brand}"`);
  }
});

// catalog invariants ────────────────────────────────────────────────────────
test("catalog: every model is level/backend annotated with honest flags", () => {
  assert.ok(FREE_MODELS.length >= 10);
  for (const m of FREE_MODELS as FreeModel[]) {
    assert.ok(["arena-local", "on-device", "remote"].includes(m.level), `${m.id} level`);
    assert.equal(typeof m.backend, "string", `${m.id} backend`);
    for (const flag of ["requiresNetwork", "requiresKey", "requiresDownload"] as const) {
      assert.equal(typeof m[flag], "boolean", `${m.id}.${flag}`);
    }
    if (m.level === "arena-local") {
      assert.equal(m.requiresNetwork && m.requiresKey && m.requiresDownload, false);
    }
    if (m.level === "remote") assert.equal(m.requiresNetwork, true);
    if (m.backend === "webllm" || m.backend === "turboagent") {
      assert.equal(m.level, "on-device");
      assert.equal(m.requiresNetwork, false);
    }
  }
  // Quality/speed are expectations, never measurements — labelled as such.
  const info = describeRuntimeModel(getModel("openai"));
  assert.ok(info.qualityExpectation.startsWith("Expected quality"));
  assert.ok(info.speedExpectation.startsWith("Expected") || info.speedExpectation === "Instant (deterministic)");
});

// 5 ─────────────────────────────────────────────────────────────────────────
test("level 1: WebLLM reports runtimeLevel=on-device (real executor)", async () => {
  const r = await generate(
    { modelId: "webllm-llama-3.2-3b", messages: msg("hello on device") },
    { webllmExecutor: async () => "on-device weights answered" },
  );
  assert.equal(r.runtimeLevel, "on-device");
  assert.equal(r.backend, "webllm");
  assert.equal(r.modelId, "webllm-llama-3.2-3b");
  assert.equal(r.fallback, false);
  assert.equal(r.text, "on-device weights answered");
  assert.ok(r.via.startsWith("webllm:"));
  assert.equal(r.provider, "webllm");
});

// 5b — server-side WebLLM without an executor is an honest browser-only fallback
test("level 1: server-side WebLLM is an honest browser-only fallback", async () => {
  const r = await generate({ modelId: "webllm-qwen-coder-1.5b", messages: msg("hi") });
  assert.equal(r.fallback, true);
  assert.equal(r.runtimeLevel, "arena-local");
  assert.equal(r.fallbackFrom?.backend, "webllm");
  assert.equal(r.fallbackReason, "WebLLM is browser-only.");
});

// 6 ─────────────────────────────────────────────────────────────────────────
test("level 1: TurboAgent reports runtimeLevel=on-device (real server)", async () => {
  const ta = countingFetch();
  const r = await generate(
    { modelId: "turboagent-32b", messages: msg("hi"), keys: { turboagent: "http://127.0.0.1:7860" } },
    { fetchImpl: ta.impl },
  );
  assert.equal(ta.calls.filter((c) => c.includes("/v1/chat/completions")).length, 1, "hit the local server");
  assert.equal(r.runtimeLevel, "on-device");
  assert.equal(r.backend, "turboagent");
  assert.equal(r.fallback, false);
  assert.equal(r.provider, "turboagent");
});

// 6b — TurboAgent unconfigured / unreachable is a visible fallback with reason
test("level 1: TurboAgent failures fall back visibly, never silently", async () => {
  const unconfigured = await generate({ modelId: "turboagent-7b", messages: msg("hi") });
  assert.equal(unconfigured.fallback, true);
  assert.ok(unconfigured.fallbackReason?.includes("TurboAgent"), unconfigured.fallbackReason);

  const down = countingFetch({ fail: true });
  const unreachable = await generate(
    { modelId: "turboagent-7b", messages: msg("hi"), keys: { turboagent: "http://127.0.0.1:9" } },
    { fetchImpl: down.impl },
  );
  assert.equal(unreachable.fallback, true);
  assert.equal(unreachable.fallbackFrom?.backend, "turboagent");
  assert.ok(unreachable.text.includes("**Fallback: Local Engine**"), "visible notice in the text");
});

// 7 ─────────────────────────────────────────────────────────────────────────
test("level 2: remote provider reports runtimeLevel=remote", async () => {
  const ok = countingFetch();
  const r = await generate({ modelId: "mistral", messages: msg("hello cloud") }, { fetchImpl: ok.impl });
  assert.equal(r.runtimeLevel, "remote");
  assert.equal(r.backend, "pollinations");
  assert.equal(r.modelId, "mistral");
  assert.equal(r.fallback, false);
  assert.equal(r.provider, "pollinations");
  assert.equal(r.text, "mock answer");
});

// 8 + 9 ─────────────────────────────────────────────────────────────────────
test("remote failures are visible and fallback metadata is preserved", async () => {
  const fail = countingFetch({ fail: true });
  const r = await generate({ modelId: "deepseek", messages: msg("hello") }, { fetchImpl: fail.impl });
  assert.ok(fail.calls.length >= 1, "the remote route was genuinely attempted");
  assert.equal(r.runtimeLevel, "arena-local");
  assert.equal(r.via, "offline-fallback");
  assert.equal(r.fallback, true);
  assert.deepEqual(r.fallbackFrom, { runtimeLevel: "remote", backend: "pollinations", modelId: "deepseek" });
  assert.ok(r.fallbackReason?.length! > 0, "fallbackReason is set");
  assert.ok(r.text.includes("**Fallback: Local Engine**"), "labelled in the response text");
  assert.ok(r.text.includes("DeepSeek"), "names what was requested");
});

// 8b — localOnly forced fallback preserves the requested execution too
test("local mode fallback preserves the requested execution metadata", async () => {
  const r = await generate({ modelId: "openai", messages: msg("hi"), localOnly: true });
  assert.deepEqual(r.fallbackFrom, { runtimeLevel: "remote", backend: "pollinations", modelId: "openai" });
  assert.equal(r.requestedModelId, "openai");
  assert.equal(r.modelId, LOCAL_ENGINE_ID);
});

// 10 ────────────────────────────────────────────────────────────────────────
test("battles: same-engine selections are rejected as non-genuine", () => {
  const verdict = comparisonVerdict("local-engine", "offline-sage"); // alias → same engine
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reason?.includes("same execution engine"), "says why it is not genuine");
  const imageVerdict = comparisonVerdict("local-canvas", "local-canvas");
  assert.equal(imageVerdict.allowed, false);
  // Post-execution: both fell back to the engine → labelled, not model-vs-model
  const a = localEngineResult("x", "offline-fallback", 5, { fallback: true });
  const b = localEngineResult("y", "offline", 5);
  assert.equal(executionsSameEngine(a, b), true);
  assert.equal(executionsSameEngine(a, null), false, "unknown execution is never claimed as same-engine");
});

// 11 ────────────────────────────────────────────────────────────────────────
test("battles: genuine cross-engine pairings are allowed", () => {
  assert.equal(comparisonVerdict("local-engine", "openai").allowed, true); // baseline vs remote
  assert.equal(comparisonVerdict("webllm-qwen-coder-1.5b", "openai").allowed, true); // on-device vs remote
  assert.equal(comparisonVerdict("turboagent-32b", "claude").allowed, true);
  assert.equal(comparisonVerdict("webllm-llama-3.2-3b", "turboagent-7b").allowed, true); // on-device vs on-device, different backends
  assert.equal(comparisonVerdict("openai", "mistral").allowed, true); // remote vs remote
});

// 12 ────────────────────────────────────────────────────────────────────────
test("measured latency is recorded on every result", async () => {
  const r = await generate({ modelId: "local-engine", messages: msg("hi") });
  assert.equal(typeof r.ms, "number");
  assert.ok(r.ms >= 0);
  assert.equal(r.latencyMs, r.ms, "latencyMs is the canonical alias of ms");
  const remote = await generate(
    { modelId: "openai", messages: msg("hi") },
    { fetchImpl: countingFetch().impl },
  );
  assert.equal(typeof remote.latencyMs, "number");
});

// 13 ────────────────────────────────────────────────────────────────────────
test("provider/model/backend metadata survive persistence (JSON round-trip)", async () => {
  const rows = await Promise.all([
    generate({ modelId: "local-engine", messages: msg("a") }),
    generate({ modelId: "webllm-llama-3.2-3b", messages: msg("b") }, { webllmExecutor: async () => "x" }),
    generate({ modelId: "openai", messages: msg("c") }, { fetchImpl: countingFetch().impl }),
  ]);
  for (const r of rows) {
    // What the battles table stores in runtime_a/runtime_b jsonb:
    const persisted = JSON.parse(JSON.stringify(r));
    assert.ok(persisted.runtimeLevel, "runtimeLevel survives");
    assert.ok(persisted.backend, "backend survives");
    assert.ok(persisted.provider, "provider survives");
    assert.ok(persisted.modelId, "modelId survives");
    assert.ok(typeof persisted.latencyMs === "number", "latency survives");
    assert.equal(typeof persisted.fallback, "boolean", "fallback flag survives");
  }
});

// 14 ────────────────────────────────────────────────────────────────────────
test("battle results are judged on actual execution metadata", async () => {
  const fail = countingFetch({ fail: true });
  const [a, b] = await Promise.all([
    generate({ modelId: "local-engine", messages: msg("x") }),
    generate({ modelId: "mistral", messages: msg("x") }, { fetchImpl: fail.impl }),
  ]);
  // b *says* mistral but executed on the engine → same engine, honestly labelled
  assert.equal(executionsSameEngine(a, b), true);
  assert.notEqual(b.modelId, "mistral", "executed modelId never impersonates the request");
});

// 15 ────────────────────────────────────────────────────────────────────────
test("ELO moves only from real battles (fallback/local-engine battles are unrated)", () => {
  const genuine = { backend: "pollinations" as const, fallback: false };
  assert.equal(battleRateable(genuine, { backend: "pollinations" as const, fallback: false }), true);
  const fellBack = { backend: "arena-local-engine" as const, fallback: true };
  assert.equal(battleRateable(genuine, fellBack), false, "fallback side → unrated");
  const engineSide = { backend: "arena-local-engine" as const, fallback: false };
  assert.equal(battleRateable(engineSide, genuine), false, "local-engine side (baseline) → unrated");
  assert.equal(battleRateable(null, genuine), false, "unknown execution → unrated");
});

// 17 ────────────────────────────────────────────────────────────────────────
test("level 0 requires no keys — keys are never needed for the guaranteed floor", async () => {
  const noKeys = await generate({ modelId: "local-engine", messages: msg("hi"), keys: undefined });
  assert.equal(noKeys.fallback, false);
  assert.equal(noKeys.runtimeLevel, "arena-local");
});

// 19 ────────────────────────────────────────────────────────────────────────
test("local LLM availability is runtime-detected (probes), not catalog claims", async () => {
  // TurboAgent unconfigured → NOT ready, regardless of catalog presence
  const unconfigured = await probeRuntimeStatus(countingFetch().impl, { turboagentUrl: null });
  const ta0 = unconfigured.probes.find((p) => p.backend === "turboagent")!;
  assert.equal(ta0.status, "unavailable");

  // Configured + reachable → connected (measured, not claimed)
  const okFetch = countingFetch();
  const connected = await probeRuntimeStatus(okFetch.impl, { turboagentUrl: "http://127.0.0.1:7860" });
  const ta1 = connected.probes.find((p) => p.backend === "turboagent")!;
  assert.equal(ta1.status, "connected");


  // Configured + unreachable → server-unavailable (honest)
  const down = await probeRuntimeStatus(countingFetch({ fail: true }).impl, { turboagentUrl: "http://127.0.0.1:9" });
  const ta2 = down.probes.find((p) => p.backend === "turboagent")!;
  assert.equal(ta2.status, "server-unavailable");

  // Remote provider probe: failure is network-unavailable, not "ready by catalog"
  const remoteDown = await probeRuntimeStatus(countingFetch({ fail: true }).impl, { turboagentUrl: null });
  const poll = remoteDown.probes.find((p) => p.backend === "pollinations")!;
  assert.equal(poll.status, "network-unavailable");
});

// UI helpers ────────────────────────────────────────────────────────────────
test("UI helpers report the true backend, never a false identity", () => {
  const engine = localEngineResult("x", "offline", 1);
  assert.equal(poweredBy(engine), "Arena Local Engine");
  const engineFallback = localEngineResult("x", "offline-fallback", 1, { fallback: true });
  assert.equal(poweredBy(engineFallback), "Arena Local Engine (fallback)");
  const remote = { runtimeLevel: "remote" as const, backend: "pollinations" as const, modelId: "deepseek", fallback: false };
  assert.equal(poweredBy(remote), "deepseek · pollinations");
  assert.ok(runtimeBadge(engine).includes("no network"));
  assert.ok(runtimeBadge(remote).startsWith("☁"));
  assert.equal(LEVEL_NUMBER["on-device"], 1);
  assert.equal(LEVEL_NUMBER.remote, 2);
});
