/**
 * LocalJobBroker unit tests — desktop queue semantics without BullMQ:
 * serial execution, honest rejection for unregistered queues, jobId dedup
 * while in-flight, drain, and stats/events.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalJobBroker } from "@workspace/arena/lib/waveyard/worker-local/broker";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("broker runs jobs serially in submission order", async () => {
  const broker = new LocalJobBroker();
  const order: string[] = [];
  const gate = deferred();
  broker.register("q", async (payload) => {
    order.push(String(payload.name));
    if (payload.slow) await gate.promise;
  });
  await broker.submit("q", "1", { name: "first", slow: true });
  await broker.submit("q", "2", { name: "second" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["first"]); // second waits for the first
  gate.resolve();
  const drained = await broker.drain(2000);
  assert.equal(drained, true);
  assert.deepEqual(order, ["first", "second"]);
});

test("broker rejects unknown queues with an honest desktop reason", async () => {
  const broker = new LocalJobBroker();
  await assert.rejects(
    broker.submit("waveyard-separation", "job-1", {}),
    /no local executor for the "waveyard-separation" queue/,
  );
  const stats = broker.stats();
  assert.equal(stats.rejected, 1);
  assert.equal(stats.submitted, 0);
  assert.deepEqual(stats.queues, []);
});

test("broker dedupes a jobId while it is in flight", async () => {
  const broker = new LocalJobBroker();
  const gate = deferred();
  let runs = 0;
  broker.register("q", async () => {
    runs += 1;
    await gate.promise;
  });
  await broker.submit("q", "same", {});
  await broker.submit("q", "same", {}); // BullMQ jobId semantics: no duplicate
  gate.resolve();
  await broker.drain(2000);
  assert.equal(runs, 1);
  assert.equal(broker.stats().submitted, 1);
});

test("broker records failure events and keeps going", async () => {
  const broker = new LocalJobBroker();
  const events: string[] = [];
  broker.onEvent((event) => events.push(event.kind));
  broker.register("q", async (payload) => {
    if (payload.fail) throw new Error("engine exploded");
  });
  await broker.submit("q", "a", { fail: true });
  await broker.submit("q", "b", {});
  await broker.drain(2000);
  assert.equal(broker.stats().failed, 1);
  assert.equal(broker.stats().succeeded, 1);
  assert.ok(events.includes("failed"));
  assert.ok(events.includes("succeeded"));
});

test("broker aborts a running handler and waits for its cleanup before releasing the job id", async () => {
  const broker = new LocalJobBroker();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let observedAbort = false;
  broker.registerCancellable("separation", async (_payload, { signal }) => {
    markStarted();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve();
      }, { once: true });
    });
  });
  await broker.submit("separation", "running-job", {});
  await started;

  assert.equal(broker.isRunning("running-job"), true);
  assert.equal(await broker.cancelActive("running-job", 500), "stopped");
  await broker.drain(500);
  assert.equal(observedAbort, true);
  assert.equal(broker.stats().cancelled, 1);
  assert.equal(broker.stats().succeeded, 0);
  assert.equal(broker.isRunning("running-job"), false);
});

test("a queued job is not mistaken for an active cancellation target", async () => {
  const broker = new LocalJobBroker();
  const gate = deferred();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const order: string[] = [];
  broker.register("separation", async (payload) => {
    const name = String(payload.name);
    order.push(name);
    if (name === "first") {
      markStarted();
      await gate.promise;
    }
  });
  await broker.submit("separation", "first", { name: "first" });
  await started;
  await broker.submit("separation", "queued", { name: "queued" });

  assert.equal(broker.isRunning("queued"), false);
  assert.equal(await broker.cancelActive("queued", 50), "not-active");
  gate.resolve();
  assert.equal(await broker.drain(500), true);
  assert.deepEqual(order, ["first", "queued"]);
});

test("localWorkerActive reflects desktop mode env", async () => {
  const { localWorkerActive, resetLocalJobBrokerForTests } = await import("@workspace/arena/lib/waveyard/worker-local/broker");
  const original = process.env.ARENA_DESKTOP_MODE;
  const originalRedis = process.env.REDIS_URL;
  try {
    process.env.REDIS_URL = "";
    process.env.ARENA_DESKTOP_MODE = "1";
    assert.equal(localWorkerActive(), true);
    process.env.ARENA_DESKTOP_MODE = "";
    assert.equal(localWorkerActive(), false);
    process.env.ARENA_DESKTOP_MODE = "1";
    process.env.REDIS_URL = "redis://localhost:6379";
    assert.equal(localWorkerActive(), false); // cloud worker takes precedence
  } finally {
    process.env.ARENA_DESKTOP_MODE = original;
    process.env.REDIS_URL = originalRedis;
    resetLocalJobBrokerForTests();
  }
});

test("local worker keeps handlers registered when orphan cleanup fails and remains idempotent", async () => {
  const { startLocalWorker } = await import("./index");
  const { resetLocalJobBrokerForTests } = await import("./broker");
  const { isStartupCleanupPending } = await import("./startup-cleanup");
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  const previousRedisUrl = process.env.REDIS_URL;
  let waveformCleanupRuns = 0;
  let sourceCleanupRuns = 0;

  try {
    process.env.ARENA_DESKTOP_MODE = "1";
    delete process.env.REDIS_URL;
    resetLocalJobBrokerForTests();

    const cleanupOverrides = {
      waveform: async () => {
        waveformCleanupRuns += 1;
        throw Object.assign(new Error("waveform storage unavailable"), { code: "EACCES" });
      },
      source: async () => {
        sourceCleanupRuns += 1;
        throw new Error("source storage unavailable");
      },
    };
    const broker = startLocalWorker(cleanupOverrides);

    assert.ok(broker, "broker starts in desktop mode even when cleanup fails");
    assert.deepEqual(broker.registeredQueues(), [
      "waveyard-waveform",
      "waveyard-separation",
      "waveyard-source-analysis",
      "waveyard-source-section-analysis",
      "waveyard-export",
    ]);
    assert.equal(isStartupCleanupPending("waveforms"), true,
      "waveform orphan cleanup is initiated by worker startup");

    assert.equal(startLocalWorker({
      waveform: async () => { waveformCleanupRuns += 1; },
      source: async () => { sourceCleanupRuns += 1; },
    }), broker, "repeated startup returns the existing broker");

    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(waveformCleanupRuns, 1, "waveform cleanup runs once despite repeated startup");
    assert.equal(sourceCleanupRuns, 1, "source cleanup runs once despite repeated startup");
    assert.equal(isStartupCleanupPending("waveforms"), false,
      "a failed waveform cleanup is handled and clears its pending state");
    assert.deepEqual(broker.registeredQueues(), [
      "waveyard-waveform",
      "waveyard-separation",
      "waveyard-source-analysis",
      "waveyard-source-section-analysis",
      "waveyard-export",
    ], "cleanup failures do not prevent or duplicate handler registration");
  } finally {
    resetLocalJobBrokerForTests();
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  }
});
