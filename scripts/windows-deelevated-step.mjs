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
import { spawnSync } from "node:child_process";
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
const [program, ...programArgs] = args;

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
    `${commandLine} > "${log}" 2>&1`,
    `echo %ERRORLEVEL%> "${statusFile}"`,
    "endlocal",
    "",
  ].join("\r\n"),
  "utf8",
);

// Let Node do the argument quoting. Hand-rolling it produced a nested-quote
// form that cmd.exe mis-parsed (runas exited 1 with no output on the runner).
const runas = spawnSync("runas", ["/trustlevel:0x20000", `cmd.exe /c ${bat}`], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
console.log(`[deelevated] runas: exit=${String(runas.status)} ${(runas.stdout ?? "").trim()} ${(runas.stderr ?? "").trim()}`.trim());
if (runas.status !== 0) {
  console.log(`::error title=${label}::runas /trustlevel failed (${String(runas.status)}) ${(runas.stderr ?? "").trim()}`);
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
let status;
while (Date.now() < deadline) {
  if (existsSync(statusFile)) {
    status = readFileSync(statusFile, "utf8").trim();
    break;
  }
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
}

const output = existsSync(log) ? readFileSync(log, "utf8") : "";
if (output !== "") {
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

if (status === undefined) {
  console.log(`::error title=${label}::de-elevated command produced no completion sentinel within ${timeoutMs} ms`);
  process.exit(1);
}
if (status !== "0") {
  const lines = output.split(/\r?\n/).filter((line) => /fatal|error|fail|refus|denied|could not/i.test(line)).slice(0, 6).join(" | ");
  console.log(`[deelevated] ${label}: FAIL (exit=${status})`);
  console.log(`::error title=${label}::de-elevated exit ${status} — ${lines.slice(0, 900) || "no error lines"}`);
  process.exit(Number(status) || 1);
}
console.log(`[deelevated] ${label}: PASS`);
