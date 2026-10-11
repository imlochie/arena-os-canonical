import assert from "node:assert/strict";
import test from "node:test";
import { executeWorker, WorkerExecutionError } from "./workerExecutor";
import type { WorkforceAssignment } from "./workforceResolver";

function assignment(overrides: Partial<WorkforceAssignment> = {}): WorkforceAssignment {
  return {
    slot: "synthesis", requestedRole: "Synthesizer", workforceRoleId: "researcher",
    workerId: "model:openai", workerName: "Forge GPT", provider: "pollinations · openai",
    modelId: "openai", executionMode: "online", eligibilityDecision: "eligible",
    workerAvailability: "available", capabilitiesConsidered: ["structured_output"],
    selectionReason: "test", capabilityMatch: [], promptFragment: "Synthesize", ...overrides,
  };
}

test("assigned remote execution uses one exact provider route and reports actual provenance", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await executeWorker({
      assignment: assignment(), messages: [{ role: "user", content: "work" }],
      outputContract: "structured_json",
    });
    assert.equal(calls, 1);
    assert.equal(result.via, "pollinations:openai");
    assert.equal(result.actualProvider, "pollinations");
    assert.equal(result.actualModelId, "openai");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assigned worker failure is structured and never invokes a hidden fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("provider down");
  };
  try {
    await assert.rejects(
      () => executeWorker({ assignment: assignment(), messages: [{ role: "user", content: "work" }] }),
      (error: any) => error instanceof WorkerExecutionError &&
        error.code === "WORKER_EXECUTION_FAILED" && /without fallback/.test(error.message)
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline assignment executes locally with no network access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network must not run"); };
  try {
    const result = await executeWorker({
      assignment: assignment({
        workerId: "model:offline-sage", modelId: "offline-sage", provider: "local · built-in",
        executionMode: "offline",
      }),
      messages: [{ role: "user", content: "work" }],
    });
    assert.equal(calls, 0);
    assert.equal(result.actualProvider, "local_forge");
    assert.equal(result.actualModelId, "offline-sage");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider aborts become retryable WORKER_TIMEOUT failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException("timed out", "AbortError"); };
  try {
    await assert.rejects(
      () => executeWorker({ assignment: assignment(), messages: [{ role: "user", content: "work" }] }),
      (error: any) => error instanceof WorkerExecutionError &&
        error.code === "WORKER_TIMEOUT" && error.details.retryable === true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
