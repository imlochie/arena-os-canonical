import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveStemTimingBudget,
  evaluateLiveStemTimingBudget,
  LIVE_STEM_AUDIBLE_LATENCY_BUDGETS_MS,
  LIVE_STEM_TIMING_SAMPLE_COUNT,
  median,
} from "./waveyard-live-stem-timing-budget.mjs";

function timings(nativeTempo, tempoMatched) {
  return Object.fromEntries([
    ["nativeTempo", nativeTempo.map((observedSelectionToAudibleMs) => ({ observedSelectionToAudibleMs }))],
    ["tempoMatched", tempoMatched.map((observedSelectionToAudibleMs) => ({ observedSelectionToAudibleMs }))],
  ]);
}

test("live swap latency budgets use five samples and tolerate isolated runner noise", () => {
  assert.equal(LIVE_STEM_TIMING_SAMPLE_COUNT, 5);
  assert.equal(median([150, 165, 149, 1_450, 1_600]), 165);
  const result = assertLiveStemTimingBudget(
    "chromium",
    timings([150, 165, 149, 1_450, 1_600], [470, 490, 475, 2_100, 2_500]),
  );
  assert.equal(result.passed, true);
  assert.equal(result.modes.nativeTempo.observedSelectionToAudibleMedianMs, 165);
  assert.equal(result.modes.tempoMatched.observedSelectionToAudibleMedianMs, 490);
});

test("sustained slow swaps fail the per-engine median budget", () => {
  const budget = LIVE_STEM_AUDIBLE_LATENCY_BUDGETS_MS.webkit.nativeTempo;
  const samples = [budget + 25, budget + 30, budget + 35, 100, 110];
  const result = evaluateLiveStemTimingBudget("webkit", timings(samples, [400, 410, 420, 430, 440]));
  assert.equal(result.passed, false);
  assert.match(result.failures.join(" "), /nativeTempo median .* exceeds the .* budget/);
});

test("every mode needs exactly five valid observed-audibility measurements", () => {
  assert.match(
    evaluateLiveStemTimingBudget("firefox", timings([100, 110, 120], [300, 310, 320, 330, 340])).failures.join(" "),
    /nativeTempo needs exactly 5 samples/,
  );
  assert.match(
    evaluateLiveStemTimingBudget("firefox", timings([100, 110, 120, 130, 140], [300, 310, Number.NaN, 330, 340])).failures.join(" "),
    /tempoMatched contains a missing or invalid/,
  );
  assert.throws(() => median([10, -1]), /finite, non-negative/);
});
