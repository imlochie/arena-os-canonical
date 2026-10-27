import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_EXECUTION_ATTEMPTS,
  decideExecutionRetry,
  normalizeFallbackPolicy,
  normalizeMaxAttempts,
} from "./retryPolicy";

test("retry policy retries retryable failures below its deterministic limit", () => {
  assert.equal(DEFAULT_MAX_EXECUTION_ATTEMPTS, 2);
  assert.deepEqual(decideExecutionRetry({ attemptNumber: 1, maxAttempts: 2, retryable: true }), {
    retry: true,
    reason: "retryable failure below attempt limit",
  });
});

test("retry policy stops for exhaustion, nonretryable failures, and started streams", () => {
  assert.equal(decideExecutionRetry({ attemptNumber: 2, maxAttempts: 2, retryable: true }).retry, false);
  assert.equal(decideExecutionRetry({ attemptNumber: 1, maxAttempts: 2, retryable: false }).retry, false);
  assert.equal(decideExecutionRetry({ attemptNumber: 1, maxAttempts: 2, retryable: true, outputStarted: true }).retry, false);
});

test("retry and fallback policy values are bounded", () => {
  assert.equal(normalizeMaxAttempts(99), 3);
  assert.equal(normalizeMaxAttempts(0), 1);
  assert.equal(normalizeMaxAttempts(undefined), 2);
  assert.equal(normalizeFallbackPolicy("eligible_worker"), "eligible_worker");
  assert.equal(normalizeFallbackPolicy("unexpected"), "none");
});
