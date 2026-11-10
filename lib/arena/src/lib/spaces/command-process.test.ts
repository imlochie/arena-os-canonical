import test from "node:test";
import assert from "node:assert/strict";
import { runCommandProcess } from "./command-process";

test("captures output and exit code", async () => {
  const r = await runCommandProcess(process.execPath, ["-e", "console.log('hi');process.exit(3)"], { timeoutMs: 10_000 });
  assert.equal(r.code, 3);
  assert.match(r.output, /hi/);
});

test("timeout kills the process and resolves with 124", async () => {
  const r = await runCommandProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 });
  assert.equal(r.code, 124);
  assert.equal(r.timedOut, true);
});

test("abort signal cancels with 130", async () => {
  const ac = new AbortController();
  const p = runCommandProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  assert.equal((await p).code, 130);
});

test("missing binary resolves 127 without throwing", async () => {
  const r = await runCommandProcess("definitely-not-a-binary-xyz", [], { timeoutMs: 5_000 });
  assert.equal(r.code, 127);
});

/**
 * The tree-kill property, proven through a REAL descendant process.
 *
 * The other tests use a leaf child that dies on its own. The Windows bug this
 * primitive exists for is the opposite: a shell (or anything it spawned)
 * outlives the direct child, keeps the inherited stdout/stderr pipes open, and
 * `close` never fires — so a timeout hangs instead of resolving. On Windows the
 * fix is `taskkill /T`; on POSIX it is the process group. This test forces that
 * shape on whichever platform runs it: the direct child spawns a grandchild
 * that holds the pipes, and the call must still resolve at its timeout.
 */
test("a grandchild holding the inherited pipes cannot block the timeout", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    // Grandchild inherits our stdout/stderr, then outlives us.
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });",
    "process.stdout.write('grandchild:' + g.pid + '\\n');",
    "setInterval(()=>{},1000);",
  ].join("");
  const started = Date.now();
  // Watchdog: without the tree kill this call never settles (the grandchild
  // holds the pipes), so a bare await would hang the whole suite until the CI
  // job timeout and lose the reason. Race it and fail with the actual cause.
  let watchdog: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    runCommandProcess(process.execPath, ["-e", script], { timeoutMs: 1500 }),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error(
          "runCommandProcess never settled: the surviving grandchild kept the pipes open, "
          + "so the tree kill did not run (this is the Windows taskkill/process-group regression)",
        )),
        15_000,
      );
    }),
  ]).finally(() => clearTimeout(watchdog));
  const elapsed = Date.now() - started;

  assert.equal(r.code, 124, "a timeout is still reported as 124");
  assert.equal(r.timedOut, true);
  assert.match(r.output, /grandchild:\d+/);

  // Resolving at all is the assertion: with the pipes still held by the
  // grandchild, a non-tree kill would never reach 'close'. Keep a generous
  // ceiling so a slow runner is not a false failure, but far below a hang.
  assert.ok(elapsed < 15_000, `resolved in ${elapsed} ms; it must not hang`);

  // And the grandchild must actually be gone, not merely detached.
  const pid = Number(/grandchild:(\d+)/.exec(r.output)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, "grandchild pid should be reported");
  const stillAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Give the kernel a moment to reap it.
  for (let attempt = 0; attempt < 40 && stillAlive(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(stillAlive(), false, `grandchild ${pid} survived the tree kill`);
});
