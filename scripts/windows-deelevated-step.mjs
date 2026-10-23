/**
 * Run a Windows command under a NON-ELEVATED token.
 *
 * Why: PostgreSQL refuses to start when the process token is elevated —
 *
 *   "root" execution of the PostgreSQL server is not permitted.
 *   The server must be started under an unprivileged user ID ...
 *
 * GitHub's windows-latest runner executes steps as an administrator, so the
 * embedded-database acceptance cannot start PostgreSQL directly there. A real
 * user's per-user install runs unelevated; this reproduces that condition with
 * `runas /trustlevel:0x20000` (a restricted token, no password prompt).
 *
 * Usage:
 *   node scripts/windows-deelevated-step.mjs <label> <log> [timeout-ms] -- <program> [args...]
 *
 * `runas` detaches, so this writes a .bat, starts it de-elevated, polls for a
 * completion sentinel, then replays the child's output and exits with the
 * child's own status. A missing sentinel is a failure, never a pass.
 *
 * ARENA_STEP_TOLERATED_FAILURE names a reason when the caller deliberately
 * expects the command to fail (the Probe's Variant A is such a control: a cmd
 * builtin cannot write the sentinel, and the point is that the wrapper says so
 * instead of hanging). The annotation is then a `::warning` with that reason,
 * never an `::error` on a job that passes; the exit status is unchanged.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [label, logFile, timeoutRaw, dashdash, ...rest] = process.argv.slice(2);
if (label === undefined || logFile === undefined || dashdash !== "--" || rest.length === 0) {
  console.error("usage: node scripts/windows-deelevated-step.mjs <label> <log> [timeout-ms] -- <program> [args...]");
  process.exit(2);
}
const tolerated = process.env.ARENA_STEP_TOLERATED_FAILURE?.trim() || undefined;
const annotate = (detail) => tolerated === undefined
  ? `::error title=${label}::${detail}`
  : `::warning title=${label} (tolerated)::${tolerated} — ${detail}`;
const timeoutMs = timeoutRaw !== undefined && timeoutRaw !== "--" ? Number(timeoutRaw) : 30 * 60_000;
const args = timeoutRaw === "--" ? [timeoutRaw, ...rest] : rest;
let [program, ...programArgs] = args;

// A restricted token does not inherit the job's PATH additions, so a bare
// "node"/"npm" resolves to nothing and the de-elevated command dies with an
// empty log. Pin both to the runtime that is executing this script.
const nodeDir = path.dirname(process.execPath);
if (program === "node") program = process.execPath;
if (program === "npm") program = path.join(nodeDir, "npm.cmd");

const workDir = path.resolve("windows-evidence");
mkdirSync(workDir, { recursive: true });
const log = path.resolve(logFile);
const statusFile = `${log}.status`;
const bat = path.join(workDir, `deelevated-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.bat`);
rmSync(log, { force: true });
rmSync(statusFile, { force: true });

const quoted = [program, ...programArgs].map((part) => (/[\s"]/u.test(part) ? `"${part.replaceAll('"', '""')}"` : part)).join(" ");
// A .bat/.cmd invoked from another .bat without `call` REPLACES the caller:
// control never returns, so the sentinel below is never written and the step
// waits out its whole bound. That is exactly how `npm run test:desktop` (via
// npm.cmd) "never exited" for three runs while the same command launched as
// node did. `call` returns control.
const invokesBatch = /\.(cmd|bat)$/i.test(program);
const commandLine = invokesBatch ? `call ${quoted}` : quoted;
writeFileSync(
  bat,
  [
    "@echo off",
    "setlocal",
    `cd /d "${process.cwd()}"`,
    `set "PATH=${nodeDir};%PATH%"`,
    // Belt and braces: a batch program must never appear first on the line.
    `${commandLine} > "${log}" 2>&1`,
    // %ERRORLEVEL% is unset in a fresh cmd.exe (it expanded to nothing, so the
    // sentinel read "ECHO is off."). Capture it explicitly instead.
    `set "RC=%ERRORLEVEL%"`,
    `> "${statusFile}" echo %RC%`,
    "endlocal",
    "",
  ].join("\r\n"),
  "utf8",
);

// Launch runas asynchronously with a hard time limit: a prompt or an
// inherited pipe must never wedge the whole CI job (the first attempt did).
const runasResult = await new Promise((resolve) => {
  const child = spawn("runas", ["/trustlevel:0x20000", `cmd.exe /c ${bat}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const timer = setTimeout(() => {
    child.kill();
    resolve({ status: "timeout", stdout, stderr });
  }, 60_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    resolve({ status: "error", stdout, stderr: `${stderr}${error.message}` });
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve({ status: code, stdout, stderr });
  });
});
console.log(`[deelevated] runas: exit=${String(runasResult.status)} ${runasResult.stdout.trim()} ${runasResult.stderr.trim()}`.trim());
if (runasResult.status !== 0) {
  console.log(`::error title=${label}::runas /trustlevel could not launch the de-elevated command (${String(runasResult.status)}) ${runasResult.stderr.trim().slice(0, 500)}`);
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
let status;
while (Date.now() < deadline) {
  if (existsSync(statusFile)) {
    status = readFileSync(statusFile, "utf8").trim();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const output = existsSync(log) ? readFileSync(log, "utf8") : "";
if (output !== "") {
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

if (status === undefined) {
  // Report what the child DID produce: without this, a hang is only "no
  // sentinel", which cannot be investigated from the checks API.
  const produced = (existsSync(log) ? readFileSync(log, "utf8") : "").split(/\r?\n/).filter(Boolean);
  const where = produced.slice(-6).join(" | ").slice(0, 800) || "the log is empty — the command never started";
  console.log(annotate(`no completion sentinel within ${timeoutMs} ms; last output: ${where}`));
  process.exit(1);
}
if (status !== "0") {
  // Name WHAT failed, not what merely mentions "fail": the previous filter
  // matched passing tests whose names contain "FAILS" and reported them as the
  // failure. Both reporter formats are read: the spec reporter marks a failure
  // with a leading ✖, the TAP reporter with "not ok N -".
  const all = output.split(/\r?\n/).map((line) => line.trimEnd());
  const failing = all.filter((line) => /^\s*✖\s/.test(line) || /^not ok \d+/.test(line));
  const counts = all.filter((line) => /^# (tests|pass|fail|cancelled) \d+/.test(line) || /^\s*ℹ (tests|pass|fail|cancelled) \d+/.test(line));
  const undiagnosed = failing.length === 0
    ? all.filter((line) => /fatal|ECONNREFUSED|not recognized|could not|refused|EACCES|EPERM|timed out/i.test(line) && !/^\s*✔/.test(line)).slice(-4)
    : [];
  // The handle dump is the reason this reporter exists; it must survive the
  // trip through the checks API even when the job log host is unreachable.
  const handleLines = all.filter((line) => line.includes("[handle-reporter]")).slice(-6);
  // A timed-out test is named but not explained: the phase lines it printed
  // before it stalled are the explanation, and without this they exist only in
  // the job log. Scope them to the failing test's own block — an earlier
  // version took the last phase lines in the whole log and attributed another
  // file's progress to this failure, which is worse than saying nothing.
  const anchor = failing.length > 0 ? all.lastIndexOf(failing[0]) : -1;
  let blockStart = 0;
  for (let i = anchor - 1; i >= 0; i -= 1) {
    if (/^(ok|not ok) \d+/.test(all[i]) || all[i].startsWith("# Subtest:")) { blockStart = i + 1; break; }
  }
  const phases = anchor < 0 ? [] : all.slice(blockStart, anchor).filter((line) => line.includes("[phase]")).slice(-6);
  const timedOut = anchor < 0
    ? []
    : all.slice(anchor, anchor + 24).filter((line) => /timed out after \d+\s*ms/i.test(line)).slice(0, 2);
  const lines = [...failing.slice(0, 10), ...(failing.length > 10 ? [`…+${failing.length - 10} more`] : []), ...timedOut, ...phases, ...undiagnosed, ...handleLines, ...counts.slice(-4)].join(" | ");
  console.log(`[deelevated] ${label}: FAIL (exit=${status})`);
  console.log(`[deelevated] failing identities: ${failing.length}`);
  console.log(annotate(`de-elevated exit ${status} — ${lines.slice(0, 900) || "no failing test line and no error line in the log"}`));
  process.exit(Number(status) || 1);
}
// "Exit 0" alone does not say what ran. Carry the counts, so a green gate
// cannot hide a file that silently ran nothing.
const passCounts = output.split(/\r?\n/)
  .filter((line) => /^(#|ℹ) (tests|pass|fail|cancelled|skipped) \d+/.test(line.trim()))
  .map((line) => line.trim())
  .slice(-8)
  .join(" ");
const firstLines = output.split(/\r?\n/).slice(0, 2).join(" | ").slice(0, 200);
console.log(`[deelevated] ${label}: PASS ${passCounts}`);
console.log(`::warning title=${label} verified::de-elevated exit 0 — ${passCounts || firstLines}`);
