import test from "node:test";
import assert from "node:assert/strict";

import { ChildProcessRegistry, killTree } from "./processes";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` holds or `ms` elapses. Unlike a fixed sleep this
 * makes no latency assumption: on a loaded Windows machine (real-time AV
 * scanning, test files running in parallel) a child's first stdout chunk
 * can legitimately take longer than any hard-coded delay.
 */
const waitFor = async (ms: number, predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(25);
};

test("registry tracks children and captures their output", async () => {
  const registry = new ChildProcessRegistry();
  let out = "";
  const child = registry.spawn(
    process.execPath,
    ["-e", "console.log('arena-child-ok'); setInterval(() => {}, 1000);"],
    { onStdout: (chunk) => { out += chunk; } },
  );
  try {
    assert.equal(registry.size, 1);
    await waitFor(10_000, () => out.includes("arena-child-ok"));
    assert.ok(out.includes("arena-child-ok"), `captured: ${out}`);

    await registry.shutdownAll(3000);
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      "child must have exited",
    );
    assert.equal(registry.size, 0);
  } finally {
    // A failed assertion must never leave the child running: it never exits
    // on its own and its stdio pipes keep this file's event loop alive,
    // which hangs `node --test` indefinitely (observed as a 38-minute
    // Windows suite run). shutdownAll after a successful shutdown is a
    // no-op (the registry is already empty).
    await registry.shutdownAll(3000);
  }
});

test("shutdownAll leaves nothing behind even for slow children", async () => {
  const registry = new ChildProcessRegistry();
  const child = registry.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000); process.on('SIGTERM', () => setTimeout(() => {}, 200));"],
  );
  await sleep(250);
  const start = Date.now();
  await registry.shutdownAll(500);
  assert.ok(Date.now() - start < 5000, "shutdown must not hang");
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("killTree uses taskkill /T /F on win32 (process trees have no groups)", async () => {
  const calls: Array<[string, string[]]> = [];
  const fakeChild = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  };
  await killTree(fakeChild, {
    platform: "win32",
    run: async (cmd, args) => {
      calls.push([cmd, args]);
    },
  });
  assert.deepEqual(calls, [["taskkill", ["/pid", "4242", "/T", "/F"]]]);
});

test("killTree sends SIGTERM on posix", async () => {
  const kills: string[] = [];
  const fakeChild = {
    pid: 99,
    exitCode: null,
    signalCode: null,
    kill: (signal?: string) => {
      kills.push(signal ?? "default");
      return true;
    },
  };
  await killTree(fakeChild, { platform: "linux" });
  assert.deepEqual(kills, ["SIGTERM"]);
});
