import assert from "node:assert/strict";
import test from "node:test";
import { killProcessTree } from "./process-tree.mjs";

test("Windows timeout kills the API process tree with taskkill", async () => {
  const calls = [];
  const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => assert.fail("must use taskkill") };
  await killProcessTree(child, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    runCommand: async (command, args) => calls.push([command, args]),
  });
  assert.deepEqual(calls, [[
    "C:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4242", "/T", "/F"],
  ]]);
});

test("Windows taskkill failure is surfaced while the child is still alive", async () => {
  const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => true };
  await assert.rejects(
    killProcessTree(child, {
      platform: "win32",
      runCommand: async () => { throw new Error("taskkill failed"); },
    }),
    /taskkill failed/,
  );
});

test("non-Windows timeout sends SIGTERM to the child", async () => {
  const signals = [];
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: (signal) => { signals.push(signal); return true; },
  };
  await killProcessTree(child, { platform: "linux" });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("an already exited child is left alone", async () => {
  let killed = false;
  await killProcessTree({
    pid: 4242,
    exitCode: 0,
    signalCode: null,
    kill: () => { killed = true; return true; },
  }, {
    platform: "win32",
    runCommand: async () => { killed = true; },
  });
  assert.equal(killed, false);
});
