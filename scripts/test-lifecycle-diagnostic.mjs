/**
 * Per-file test lifecycle diagnostic (Windows first, any OS).
 *
 * `npm run test:desktop` on Windows reports every test passing and then the
 * process never exits, so the gate cannot record a clean status. Running the
 * whole glob tells us *that* it hangs; it does not tell us *which file* holds
 * the handle. This runs each file in its own process with a hard bound and
 * reports, per file:
 *
 *   pass      — exited 0 within the bound
 *   fail      — exited non-zero (the file's own TAP is printed)
 *   no-exit   — all tests reported, then the process stayed alive past the
 *               bound: the file that leaves a handle behind
 *   timeout   — did not finish its tests within the bound
 *
 * A `no-exit` result is the useful signal: it names the culprit per file and
 * keeps every other file's result clean. Uses `--test-timeout` so a hung test
 * is reported as a failure instead of stalling the whole run.
 *
 * Usage: node scripts/test-lifecycle-diagnostic.mjs [--bound-ms N]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
};
const boundMs = Number(option("--bound-ms", "180000"));
const evidenceDir = path.resolve(process.env.EVIDENCE ?? "windows-evidence");
mkdirSync(evidenceDir, { recursive: true });

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = [...collect("desktop"), ...collect("src/lib/waveyard/worker-local")].map((f) => f.split(path.sep).join("/")).sort();

const results = [];
for (const file of files) {
  const started = Date.now();
  // The per-test budget must fire BEFORE the file bound, otherwise a hung test
  // is killed silently and the file is classified without ever naming the test
  // that hung. 20 s of headroom is enough for the runner to print its failure
  // and for the file to exit on its own.
  const perTestMs = Math.max(10_000, boundMs - 20_000);
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/register-src-loader.mjs", "--test", `--test-timeout=${perTestMs}`, file],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));

  let finishedTests = false;
  const watch = setInterval(() => {
    if (/# duration_ms [\d.]+/.test(output)) finishedTests = true;
  }, 500);

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(finishedTests ? "no-exit" : "timeout");
    }, boundMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? "pass" : "fail");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve("fail");
    });
  });
  clearInterval(watch);

  const summary = /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/.exec(output);
  const entry = {
    file,
    outcome,
    ms: Date.now() - started,
    tests: summary ? Number(summary[1]) : null,
    pass: summary ? Number(summary[2]) : null,
    fail: summary ? Number(summary[3]) : null,
    tail: output.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(0, 700),
  };
  results.push(entry);
  // Written per file, not at the end: a job that is killed mid-run still
  // leaves the files it already classified.
  writeFileSync(path.join(evidenceDir, "test-lifecycle.json"), JSON.stringify({ boundMs, results }, null, 2));
  console.log(`[lifecycle] ${outcome.padEnd(8)} ${file} (${entry.ms} ms) tests=${entry.tests ?? "?"} pass=${entry.pass ?? "?"} fail=${entry.fail ?? "?"}`);
  if (outcome === "no-exit" || outcome === "timeout" || outcome === "fail") {
    // Annotations survive even when the job log host is unreachable, so the
    // failing test names travel with them: a file classified as `timeout` that
    // does not say which test hung is only marginally better than "it hangs".
    const names = output.split(/\r?\n/)
      .filter((line) => /^\s*✖\s/.test(line) || /^not ok \d+/.test(line))
      .map((line) => line.replace(/^\s*✖\s*/, "").replace(/^not ok \d+ - /, "").trim())
      .slice(0, 6);
    // A name without a reason cannot be acted on: carry the assertion/crash
    // line that the reporter printed next to it.
    const reasons = output.split(/\r?\n/)
      .filter((line) => /^\s*(error|code|failureType):/.test(line) || /ERR_TEST_FAILURE|Error:|timed out after/.test(line))
      .map((line) => line.trim())
      .slice(0, 3);
    const detail = [...names, ...reasons].join(" | ") || entry.tail;
    console.log(`::warning title=lifecycle ${outcome}::${file} — ${detail.slice(0, 700)}`);
  }
}

writeFileSync(path.join(evidenceDir, "test-lifecycle.json"), JSON.stringify({ boundMs, results }, null, 2));
const notPassing = results.filter((r) => r.outcome !== "pass");
console.log(`[lifecycle] ${results.length - notPassing.length}/${results.length} files exit cleanly`);
for (const entry of notPassing) console.log(`::warning title=lifecycle summary::${entry.outcome} ${entry.file}`);
process.exitCode = 0;
