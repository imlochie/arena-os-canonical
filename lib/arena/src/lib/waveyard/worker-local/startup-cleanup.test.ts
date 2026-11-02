import assert from "node:assert/strict";
import test from "node:test";
import {
  isStartupCleanupPending,
  runStartupCleanup,
} from "./startup-cleanup";
import { isTransientWaveformFailure } from "./waveform";

test("startup cleanup retries a transient failure and clears its pending state", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const retryNotices: Array<{ attempt: number; nextAttempt: number; delayMs: number }> = [];
  const cleanup = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("temporary storage outage"), { code: "ECONNRESET" });
  };
  const work = runStartupCleanup("waveform-success", cleanup, {
    isTransient: isTransientWaveformFailure,
    maxAttempts: 3,
    retryDelaysMs: [25, 75],
    sleep: async delay => { delays.push(delay); },
    onRetry: ({ attempt, nextAttempt, delayMs }) => retryNotices.push({ attempt, nextAttempt, delayMs }),
  });
  assert.equal(isStartupCleanupPending("waveform-success"), true);
  assert.equal(runStartupCleanup("waveform-success", cleanup, { isTransient: isTransientWaveformFailure }), work,
    "a repeated startup call shares one bounded cleanup");
  assert.deepEqual(await work, { status: "complete", attempts: 2 });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [25]);
  assert.deepEqual(retryNotices, [{ attempt: 1, nextAttempt: 2, delayMs: 25 }]);
  assert.equal(isStartupCleanupPending("waveform-success"), false,
    "a successful retry clears the pending cleanup state");
});

test("startup cleanup stops after its finite retry budget", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const failure = Object.assign(new Error("database timed out"), { code: "ETIMEDOUT" });
  const work = runStartupCleanup("waveform-exhausted", async () => {
    attempts++;
    throw failure;
  }, {
    isTransient: isTransientWaveformFailure,
    maxAttempts: 3,
    retryDelaysMs: [10, 20],
    sleep: async delay => { delays.push(delay); },
  });
  assert.deepEqual(await work, { status: "deferred", attempts: 3, error: failure });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(isStartupCleanupPending("waveform-exhausted"), false);
});

test("startup cleanup does not retry a permanent failure", async () => {
  let attempts = 0;
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const result = await runStartupCleanup("waveform-permanent", async () => {
    attempts++;
    throw failure;
  }, {
    isTransient: isTransientWaveformFailure,
    sleep: async () => { throw new Error("a permanent error must not schedule a retry"); },
  });
  assert.deepEqual(result, { status: "deferred", attempts: 1, error: failure });
  assert.equal(attempts, 1);
  assert.equal(isStartupCleanupPending("waveform-permanent"), false);
});

test("wrapped PostgreSQL connection failures are retryable but schema errors are not", () => {
  const outage = {
    message: "database request failed",
    cause: Object.assign(new Error("server closed the connection"), { code: "08006" }),
  };
  assert.equal(isTransientWaveformFailure(outage), true);
  assert.equal(isTransientWaveformFailure(Object.assign(new Error("relation does not exist"), {
    code: "42P01",
  })), false);
});

test("local worker registers job handlers while startup cleanup is still in flight", async () => {
  const { startLocalWorker } = await import("./index");
  const { resetLocalJobBrokerForTests } = await import("./broker");
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  const previousRedisUrl = process.env.REDIS_URL;
  let finishCleanup!: () => void;
  const pendingCleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  try {
    process.env.ARENA_DESKTOP_MODE = "1";
    delete process.env.REDIS_URL;
    resetLocalJobBrokerForTests();
    const broker = startLocalWorker({
      waveform: () => pendingCleanup,
      source: async () => [],
    });
    assert.ok(broker?.hasHandler("waveyard-waveform"),
      "a pending orphan cleanup must not hold up waveform processing");
    assert.equal(isStartupCleanupPending("waveforms"), true);
    finishCleanup();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(isStartupCleanupPending("waveforms"), false,
      "successful cleanup removes its in-flight state");
  } finally {
    finishCleanup();
    resetLocalJobBrokerForTests();
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  }
});
