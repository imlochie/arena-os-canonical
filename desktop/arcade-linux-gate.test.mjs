import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
test("real Linux gate denies missing/invalid grants and relative executables", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-gate-test-"));
  try {
    const gate = path.join(directory, "gate");
    const source = fileURLToPath(new URL("./native/arcade-linux-gate.c", import.meta.url));
    await exec("gcc", ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", gate], { timeout: 15000 });
    // Use the existing trusted system executable; no Wine or games run.
    const executable = await realpath("/bin/true");
    for (const [args, input, expected] of [
      [["--gated", executable], "", 65],
      [["--gated", executable], "X", 65],
      [["--reset", "relative-command"], "", 64],
      [["--unknown", executable], "", 64],
      [["--gated", executable], "G", 0],
    ]) {
      // execFile's input pipe must be explicitly ended to exercise EOF.
      const code = await new Promise((resolve, reject) => {
        const child = execFile(gate, args, { timeout: 3000 }, error => {
          if (error && typeof error.code !== "number") reject(error);
          else resolve(error?.code ?? 0);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      });
      assert.equal(code, expected, `${args[0]} with grant ${JSON.stringify(input)}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
