/**
 * Runtime policy tests — the ONE definition of who processes jobs. Every
 * combination that a real deployment can present, including both override
 * directions and the never-surprise-external rule.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { processingModeExplanation, resolveProcessingMode, shouldRunLocalWorker } from "./runtime-policy";

test("desktop mode without Redis processes in-process", () => {
  assert.equal(resolveProcessingMode({ ARENA_DESKTOP_MODE: "1" }), "in-process");
  assert.equal(resolveProcessingMode({ ARENA_DESKTOP_MODE: "1", REDIS_URL: "" }), "in-process");
  assert.ok(shouldRunLocalWorker({ ARENA_DESKTOP_MODE: "1" }));
});

test("dev servers process in-process — the first-run gap is closed", () => {
  assert.equal(resolveProcessingMode({ NODE_ENV: "development" }), "in-process");
  assert.ok(shouldRunLocalWorker({ NODE_ENV: "development" }));
  // The documented dev flow: npm run dev with a .env DATABASE_URL, no Redis.
  assert.equal(resolveProcessingMode({ NODE_ENV: "development", ARENA_DESKTOP_MODE: "" }), "in-process");
});

test("production web without Redis is honestly none", () => {
  assert.equal(resolveProcessingMode({}), "none");
  assert.equal(resolveProcessingMode({ NODE_ENV: "production" }), "none");
  assert.ok(!shouldRunLocalWorker({ NODE_ENV: "production" }));
});

test("REDIS_URL always wins toward external — no surprise in-process worker", () => {
  for (const env of [
    { REDIS_URL: "redis://x", ARENA_DESKTOP_MODE: "1" },
    { REDIS_URL: "redis://x", NODE_ENV: "development" },
    { REDIS_URL: "redis://x", WAVEYARD_LOCAL_WORKER: "1" },
  ]) {
    assert.equal(resolveProcessingMode(env), "external", JSON.stringify(env));
    assert.ok(!shouldRunLocalWorker(env));
  }
});

test("the override works in both directions", () => {
  assert.equal(resolveProcessingMode({ NODE_ENV: "development", WAVEYARD_LOCAL_WORKER: "0" }), "none", "a second dev server can decline processing");
  assert.equal(resolveProcessingMode({ NODE_ENV: "production", WAVEYARD_LOCAL_WORKER: "1" }), "in-process", "a deliberate single-process deployment can opt in");
  assert.equal(resolveProcessingMode({ WAVEYARD_LOCAL_WORKER: " 1 " }), "in-process", "whitespace tolerated");
});

test("every mode explains itself honestly", () => {
  for (const mode of ["external", "in-process", "none"] as const) {
    const explanation = processingModeExplanation(mode);
    assert.ok(explanation.length > 20, `${mode} explains itself`);
  }
  assert.ok(processingModeExplanation("none").includes("No processor"), "none names the problem");
  assert.ok(processingModeExplanation("none").includes("npm run dev"), "none names the action");
});
