/** Real process/pipe crash contract, not trained-model inference. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedPythonModuleArgs } from "./python-guardian";
import { findTestPython, NO_TEST_PYTHON } from "./deep-fixtures";

async function running(pid: number) {
  try {
    process.kill(pid, 0); // Probe only. Never kill a persisted/orphan PID.
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

test("owned Python module preserves arguments and exits normally while executor is live", { timeout: 10000 }, async t => {
  const python = findTestPython(); if (!python) { t.skip(NO_TEST_PYTHON); return; }
  const dir = await mkdtemp(join(tmpdir(), "wy-guardian-"));
  try {
    await writeFile(join(dir, "owned_fixture.py"), "import sys, json, time\ntime.sleep(.1)\nprint(json.dumps(sys.argv[1:]))\n");
    const args = ["with spaces", "", "音楽"];
    const child = spawn(python, ownedPythonModuleArgs("owned_fixture", args), { env: { ...process.env, PYTHONPATH: dir }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0); assert.deepEqual(JSON.parse(output), args);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SIGKILL of executor closes ownership pipe and terminates its Python module without PID killing", { timeout: 10000 }, async t => {
  const python = findTestPython(); if (!python) { t.skip(NO_TEST_PYTHON); return; }
  const dir = await mkdtemp(join(tmpdir(), "wy-guardian-crash-"));
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    const pidPath = join(dir, "native.pid");
    // Finite sleep bounds even a broken guardian; SIGTERM is deliberately ignored.
    await writeFile(join(dir, "owned_fixture.py"), `import os, time, signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid()))\nprint('started', flush=True)\ntime.sleep(5)\n`);
    const script = `const {spawn}=require('node:child_process'); const child=spawn(${JSON.stringify(python)},${JSON.stringify(ownedPythonModuleArgs("owned_fixture", []))},{env:process.env,stdio:['pipe','pipe','pipe']}); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);`;
    parent = spawn(process.execPath, ["-e", script], { env: { ...process.env, PYTHONPATH: dir }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let output = ""; parent!.stdout!.on("data", chunk => { output += chunk; if (output.includes("started")) resolve(); });
      parent!.once("error", reject); parent!.once("exit", () => reject(new Error("Executor exited before Python started")));
    });
    const pid = Number(await readFile(pidPath, "utf8")); assert.ok(await running(pid));
    const exited = once(parent, "close"); parent.kill("SIGKILL"); await exited;
    const deadline = Date.now() + 1500;
    while (await running(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await running(pid), false, "owned module must not continue after executor crash");
  } finally {
    if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
