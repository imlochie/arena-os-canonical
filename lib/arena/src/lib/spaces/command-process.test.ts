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
