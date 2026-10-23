/**
 * Run one verification command in CI, keeping its output AND surfacing a
 * readable failure annotation.
 *
 * Why this exists: the GitHub job log is served from a blob host that is not
 * reachable from every reviewing environment; step *annotations* are. A
 * wrapper that swallows an exit code would be worse than useless, so this
 * propagates the child's status verbatim (no pipe, no `|| true`).
 *
 *   node scripts/windows-step.mjs "<label>" "<log file>" -- <program> [args...]
 *
 * Output is streamed live and mirrored to the log file. On failure the tail is
 * echoed and turned into a `::error` annotation the checks API can return.
 *
 * A step the workflow deliberately tolerates (a control, or an informational
 * audit of a tree that cannot satisfy it) sets ARENA_STEP_TOLERATED_FAILURE to
 * the reason. The annotation then becomes a `::warning` carrying that reason,
 * because the checks API is the only readable evidence in this environment and
 * a `::error` on a green job is a contradiction a reviewer has to resolve. The
 * exit status is unchanged: the workflow still decides whether to tolerate it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";

const [label, logFile, dashdash, ...rest] = process.argv.slice(2);
if (label === undefined || logFile === undefined || dashdash !== "--" || rest.length === 0) {
  console.error("usage: node scripts/windows-step.mjs <label> <log file> -- <program> [args...]");
  process.exit(2);
}

mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
const sink = createWriteStream(logFile, { flags: "a" });
const tail = [];
const keep = 200;

function emit(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  sink.write(text);
  for (const line of text.split(/\r?\n/)) if (line.trim() !== "") tail.push(line);
  while (tail.length > keep) tail.shift();
}

const tolerated = process.env.ARENA_STEP_TOLERATED_FAILURE?.trim() || undefined;
const annotate = (detail) => tolerated === undefined
  ? `::error title=${label}::${detail}`
  : `::warning title=${label} (tolerated)::${tolerated} — ${detail}`;

const command = rest[0];
const args = rest.slice(1);
const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  // Windows resolves npm/npx through .cmd shims, which need a shell.
  shell: process.platform === "win32",
  env: process.env,
});

child.stdout.on("data", emit);
child.stderr.on("data", emit);

child.on("error", (error) => {
  const message = `could not start ${command}: ${error.message}`;
  console.log(annotate(message));
  sink.end(() => process.exit(1));
});

child.on("exit", (code, signal) => {
  if (code === 0) {
    console.log(`[windows-step] ${label}: PASS`);
    sink.end(() => process.exit(0));
    return;
  }
  const detail = tail.slice(-8).join(" | ").replace(/::/g, ":").slice(0, 900);
  console.log(`[windows-step] ${label}: FAIL (exit=${String(code)} signal=${String(signal)})`);
  console.log(annotate(detail === "" ? `exit ${String(code)}` : detail));
  sink.end(() => process.exit(code === null ? 1 : code));
});
