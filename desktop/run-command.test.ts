/**
 * run-command tests — regression for the Windows .cmd spawn trap that
 * killed the first real acceptance run: npm must be invoked with a shell
 * on win32 (Node's CVE-2024-27980 hardening makes shell-less .cmd spawns a
 * silent EINVAL — no output, status null), and plainly on POSIX.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { npmCommand, runNpmSync } from "../scripts/lib/run-command.mjs";

test("npmCommand shells npm.cmd on win32 and runs plain npm on POSIX", () => {
  const win = npmCommand(["run", "typecheck"], "win32");
  assert.equal(win.command, "npm.cmd");
  assert.deepEqual(win.args, ["run", "typecheck"]);
  assert.equal(win.options.shell, true, "win32 .cmd shims require a shell");

  const posix = npmCommand(["run", "typecheck"], "linux");
  assert.equal(posix.command, "npm");
  assert.equal(posix.options.shell, undefined, "POSIX needs no shell");
});

test("runNpmSync executes npm end-to-end (a spawn error is never silent)", () => {
  const run = runNpmSync(["--version"], { encoding: "utf8" });
  assert.equal(run.error, undefined, `npm must actually start: ${String(run.error)}`);
  assert.equal(run.status, 0);
  assert.match(String(run.stdout).trim(), /^\d+\.\d+\.\d+/);
});
