import assert from "node:assert/strict";
import test from "node:test";
import { stopBeforeQuit, stopDesktopServices } from "./shutdown.mjs";

test("native shutdown failure cannot prevent API/database cleanup", async () => {
  const events = [];
  await assert.rejects(stopDesktopServices({
    stopNative: async () => { events.push("native"); throw new Error("native stop timed out"); },
    stopServices: async () => { events.push("API"); events.push("database"); },
  }), /native stop timed out/);
  assert.deepEqual(events, ["native", "API", "database"]);
});

test("shutdown retains failures from both cleanup paths", async () => {
  await assert.rejects(stopDesktopServices({
    stopNative: async () => { throw new Error("native"); },
    stopServices: async () => { throw new Error("API"); },
  }), error => error instanceof AggregateError && error.errors.length === 2 && /native; API/.test(error.message));
});

test("clean shutdown quits without showing a failure prompt", async () => {
  const events = [];
  const result = await stopBeforeQuit({
    stop: async () => events.push("stop"),
    askBeforeForceQuit: async () => {
      events.push("prompt");
      return true;
    },
    quit: () => events.push("quit"),
  });
  assert.equal(result, "clean");
  assert.deepEqual(events, ["stop", "quit"]);
});

test("a shutdown failure retries by default and quits after services stop", async () => {
  const events = [];
  let attempts = 0;
  const result = await stopBeforeQuit({
    stop: async () => {
      attempts += 1;
      events.push(`stop-${attempts}`);
      if (attempts === 1) throw new Error("PostgreSQL still running");
    },
    askBeforeForceQuit: async (error) => {
      events.push(`prompt:${error.message}`);
      return false;
    },
    quit: () => events.push("quit"),
  });
  assert.equal(result, "clean");
  assert.deepEqual(events, [
    "stop-1",
    "prompt:PostgreSQL still running",
    "stop-2",
    "quit",
  ]);
});

test("force quit is available only after an explicit warning decision", async () => {
  const events = [];
  const result = await stopBeforeQuit({
    stop: async () => {
      events.push("stop");
      throw new Error("PostgreSQL did not confirm shutdown");
    },
    askBeforeForceQuit: async (error) => {
      events.push(`warn:${error.message}`);
      return true;
    },
    quit: () => events.push("quit"),
  });
  assert.equal(result, "forced");
  assert.deepEqual(events, [
    "stop",
    "warn:PostgreSQL did not confirm shutdown",
    "quit",
  ]);
});
