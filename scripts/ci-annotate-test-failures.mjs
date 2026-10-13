/**
 * Turn a failed `npm test` TAP log into check-run annotations.
 *
 * CI's Test step writes the full TAP stream to a file (the artifact upload
 * covers a human download, but the annotations are what surface directly on
 * the pull request — and they are readable through the check-runs API).
 *
 * Usage: node scripts/ci-annotate-test-failures.mjs <tap-log-path>
 *
 * Prints workflow `::error` commands for the first `MAX_ANNOTATIONS`
 * failures, each carrying the failing test's name and its block from the
 * log, plus a final line with the summary counters. Never throws: a missing
 * or unreadable log still produces an annotation saying so, because a
 * silently-empty failure report is worse than a vague one.
 */

import { readFileSync } from "node:fs";

const MAX_ANNOTATIONS = 5;
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_CHARS = 6000;

const logPath = process.argv[2] ?? "/tmp/waveyard-test-tap.log";

function escape(value) {
  // Workflow-command escaping: % first, then newline/carriage return.
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function annotate(kind, message, title) {
  const head = title ? `${kind} title=${escape(title)}::` : `${kind}::`;
  console.log(`${head}${escape(message)}`);
}

let tap;
try {
  tap = readFileSync(logPath, "utf8");
} catch (error) {
  annotate("::error", `The test step failed and its TAP log could not be read (${logPath}): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}

const lines = tap.split(/\r?\n/);
const summary = lines.filter((line) => /^# (tests|suites|cancelled|skipped|todo|pass|fail|duration_ms) /.test(line));
const failures = [];

for (let index = 0; index < lines.length; index += 1) {
  const match = /^not ok \d+ - (.*)$/.exec(lines[index]);
  if (!match) continue;
  const detail = [];
  for (let cursor = index + 1; cursor < lines.length && detail.length < MAX_DETAIL_LINES; cursor += 1) {
    if (/^(not ok|ok) /.test(lines[cursor])) break;
    detail.push(lines[cursor]);
  }
  failures.push({ name: match[1], detail: detail.join("\n").slice(0, MAX_DETAIL_CHARS) });
}

if (failures.length === 0) {
  const tail = lines.slice(-30).join("\n").slice(0, MAX_DETAIL_CHARS);
  annotate("::error", `The test step failed without a TAP "not ok" line. Summary: ${summary.join(" ") || "(none)"}\nLog tail:\n${tail}`, "test step failed without a TAP failure");
  process.exit(0);
}

failures.slice(0, MAX_ANNOTATIONS).forEach((failure, index) => {
  annotate("::error", `Failing test: ${failure.name}\n${failure.detail}`, `TAP failure ${index + 1}/${failures.length}`);
});
if (failures.length > MAX_ANNOTATIONS) {
  annotate("::error", `${failures.length - MAX_ANNOTATIONS} more failing test(s) not shown: ${failures.slice(MAX_ANNOTATIONS).map((failure) => failure.name).join("; ")}`, "more TAP failures");
}
console.log(summary.join(" "));
