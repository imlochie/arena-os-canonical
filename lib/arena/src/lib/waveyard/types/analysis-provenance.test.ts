import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  desktopAnalysisIdempotencyKey,
  isCurrentDesktopAnalysis,
  isStaleDesktopAnalysis,
} from "./analysis-provenance";

test("desktop analysis provenance distinguishes current, stale, and other engines", () => {
  const current = {
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
  };
  assert.equal(isCurrentDesktopAnalysis(current), true);
  assert.equal(isStaleDesktopAnalysis(current), false);

  const stale = { ...current, analysisEngineVersion: "1.2.0" };
  assert.equal(isCurrentDesktopAnalysis(stale), false);
  assert.equal(isStaleDesktopAnalysis(stale), true);

  const otherEngine = { ...current, analysisEngine: "remote-worker" };
  assert.equal(isCurrentDesktopAnalysis(otherEngine), false);
  assert.equal(isStaleDesktopAnalysis(otherEngine), false);
});

test("desktop analysis idempotency keys track the engine version", () => {
  assert.equal(
    desktopAnalysisIdempotencyKey("source-123"),
    `analysis:source-123:${DESKTOP_ANALYSIS_ENGINE}:${DESKTOP_ANALYSIS_ENGINE_VERSION}`,
  );
});
