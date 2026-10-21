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

const commandLine = [program, ...programArgs].map((part) => (/[\s"]/u.test(part) ? `"${part.replaceAll('"', '""')}"` : part)).join(" ");
writeFileSync(
  bat,
  [
    "@echo off",
    "setlocal",
    `cd /d "${process.cwd()}"`,
    `set "PATH=${nodeDir};%PATH%"`,
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
  console.log(`::error title=${label}::no completion sentinel within ${timeoutMs} ms; last output: ${where}`);
  process.exit(1);
}
if (status !== "0") {
  const errorLines = output.split(/\r?\n/).filter((line) => /fatal|error|fail|refus|denied|could not|not recognized/i.test(line)).slice(0, 6);
  const fallback = output.split(/\r?\n/).filter(Boolean).slice(-3);
  const lines = (errorLines.length > 0 ? errorLines : fallback).join(" | ");
  console.log(`[deelevated] ${label}: FAIL (exit=${status})`);
  console.log(`::error title=${label}::de-elevated exit ${status} — ${lines.slice(0, 900) || "no error lines"}`);
  process.exit(Number(status) || 1);
}
const firstLines = output.split(/\r?\n/).slice(0, 3).join(" | ").slice(0, 400);
console.log(`[deelevated] ${label}: PASS`);
console.log(`::warning title=${label} verified::de-elevated exit 0 :: ${firstLines}`);
