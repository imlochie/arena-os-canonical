import assert from "node:assert/strict";
import test from "node:test";
import { serializeApiError } from "./apiErrors";
import { runtimeError } from "./errors";

test("serializes typed execution failure without exposing its raw cause", () => {
  const error = runtimeError({
    code: "WORKER_EXECUTION_FAILED",
    message: "Worker execution failed.",
    stage: "execution",
    retryable: true,
    executionId: "execution-1",
    sessionId: "session-1",
    cause: new Error("secret provider response"),
  });
  assert.deepEqual(serializeApiError(error, {
    code: "INTERNAL_ERROR", message: "Internal error.", stage: "execution",
  }), {
    code: "WORKER_EXECUTION_FAILED",
    message: "Worker execution failed.",
    stage: "execution",
    retryable: true,
    executionId: "execution-1",
    sessionId: "session-1",
  });
});

test("unknown failures use bounded route-specific fallback data", () => {
  assert.deepEqual(serializeApiError(new Error("raw provider garbage"), {
    code: "PERSISTENCE_FAILED",
    message: "Unable to persist execution.",
    stage: "persistence",
    retryable: true,
    sessionId: "session-2",
  }), {
    code: "PERSISTENCE_FAILED",
    message: "Unable to persist execution.",
    stage: "persistence",
    retryable: true,
    executionId: null,
    sessionId: "session-2",
  });
});
