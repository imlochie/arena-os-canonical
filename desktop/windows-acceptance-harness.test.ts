/**
 * windows-acceptance harness structure tests — regression for the temporal
 * dead zone crash of the FIRST real Windows acceptance run:
 *
 *   ReferenceError: Cannot access 'resultDirCache' before initialization
 *     at resultFilePath → runInstalledAcceptance → top-level execution
 *
 * The harness executes its whole main flow in a top-level `try` block, and
 * that flow calls helper functions (function declarations — hoisted, safe)
 * which reference module state. Any `let`/`const` declared at module level
 * BELOW the main block is still in its temporal dead zone when the main
 * block runs. Linux runs never reached the affected path (it needs the
 * installed app), so only a structural invariant guards it on any OS:
 *
 *   every module-level (column-0) let/const in windows-acceptance.mjs must
 *   be declared BEFORE the top-level `try {`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const harnessPath = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "scripts", "windows-acceptance.mjs");
const source = readFileSync(harnessPath, "utf8");
const lines = source.split("\n");

test("all module-level state is declared before the top-level execution block (TDZ guard)", () => {
  const tryIndex = lines.findIndex((line) => /^try \{/.test(line));
  assert.ok(tryIndex > 0, "harness must have a top-level try block");

  // Column-0 declarations = module scope (declarations inside functions and
  // the try block are indented). Anything declared after the main block
  // starts is a temporal-dead-zone hazard for the main path.
  const lateDeclarations = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > tryIndex && /^(let|const)\s+\w/.test(line));

  assert.deepEqual(
    lateDeclarations.map((entry) => entry.line.trim()),
    [],
    "module-level let/const must be declared before the top-level try block — " +
      "move them up (helpers called from the main path would hit the temporal dead zone). " +
      "Affected lines: " +
      lateDeclarations.map((entry) => `${entry.index + 1}: ${entry.line.trim()}`).join("; "),
  );
});

test("resultFilePath is a hoisted function and its state is initialized before the main block", () => {
  // The function itself must be a declaration (hoisted — callable from the
  // top-level path), and the state it touches must precede the try block.
  assert.ok(/^function resultFilePath\(/m.test(source), "resultFilePath must stay a function declaration");

  const tryIndex = lines.findIndex((line) => /^try \{/.test(line));
  const stateIndex = lines.findIndex((line) => /^let resultDirCache/.test(line));
  assert.ok(stateIndex !== -1, "resultDirCache declaration must exist");
  assert.ok(stateIndex < tryIndex, "resultDirCache must be declared before the top-level try block");
});

test("installed-app acceptance runs against an isolated fresh data root (never the real %LOCALAPPDATA%\\Arena state)", () => {
  // Regression for the Windows acceptance failure: FIRST LAUNCH failed with
  // firstRun=false because the harness derived the REAL user data dir,
  // passed no ARENA_DATA_DIR to the installed app, and pointed
  // findOwnedProcesses() at the real dir — so repeat runs reused existing
  // Arena state. The harness must now create a fresh marker-guarded root and
  // route EVERY installed-app launch through the tested plan.
  assert.ok(
    source.includes("createAcceptanceDataRoot()"),
    "the harness must create a fresh acceptance data root per run",
  );
  assert.ok(
    source.includes("planInstalledAcceptanceLaunches("),
    "every installed-app launch must come from the tested launch plan",
  );
  assert.ok(
    !source.includes("process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE"),
    "the harness must never derive the real %LOCALAPPDATA%\\Arena as acceptance state",
  );
  assert.ok(
    !/ARENA_DESKTOP_ACCEPTANCE:\s*resultFilePath/.test(source),
    "launch env must come from the plan (which also carries ARENA_DATA_DIR), never a bare result path",
  );
  assert.ok(
    source.includes("findOwnedProcesses(installDir, acceptancePlan.dataRoot)"),
    "orphan policing must target the isolated acceptance root, not the real data dir",
  );
  assert.ok(
    source.includes("removeAcceptanceDataRoot(acceptancePlan.dataRoot)"),
    "cleanup must go through the marker-guarded remover",
  );
  assert.ok(
    /await cleanupAcceptanceData\(\);\s*\}\s*catch/.test(source),
    "cleanup must run on the failure path too (before the report is written)",
  );
});

/**
 * Regression for the 2e832ed-era reporting bug: the report initializes
 * canonical UNDERSCORE keys (FIRST_LAUNCH, WAVEYARD_WORKFLOW,
 * RESTART_PERSISTENCE, PROCESS_CLEANUP) but mark() was called with SPACED
 * aliases ("FIRST LAUNCH", …). Distinct object keys — so the canonical
 * entries stayed "NOT RUN" forever while their results landed on duplicate
 * alias rows, and the NOT RUN explanation then wrongly claimed sections
 * that HAD run were never exercised. These tests pin the summary contract
 * against the real harness source.
 */

/** Canonical summary keys parsed from the harness report initializer
 * (string-valued entries only — detail/KNOWN_LIMITATIONS are not sections). */
function parseReportInitializer(source: string): Array<{ key: string; value: string }> {
  const init = /const report = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(init !== null, "harness must initialize the summary report object");
  return [...init[1].matchAll(/^\s*(?:"([^"]+)"|([A-Z][A-Z0-9_/]*)):\s*"([^"]*)",?$/gm)].map(
    (entry) => ({ key: entry[1] ?? entry[2], value: entry[3] }),
  );
}

/** Every key the harness can mark()/pass() — the full-run section set. */
function parseMarkedKeys(source: string): string[] {
  return [...source.matchAll(/\b(?:mark|pass)\(\s*"([^"]+)"/g)].map((entry) => entry[1]);
}

test("summary keys: every mark()/pass() call targets a canonical report key (spaced-alias regression)", () => {
  const entries = parseReportInitializer(source);
  assert.ok(
    entries.some((entry) => entry.key === "FIRST_LAUNCH" && entry.value === "NOT RUN"),
    "the report initializer must contain FIRST_LAUNCH (parsed correctly)",
  );
  assert.ok(
    entries.some((entry) => entry.key === "SECURITY/PACKAGING AUDIT"),
    "quoted keys (SECURITY/PACKAGING AUDIT) must parse too",
  );

  const canonicalKeys = entries.map((entry) => entry.key);
  const markedKeys = parseMarkedKeys(source);
  assert.ok(markedKeys.length >= 10, `expected the real section marks, found ${markedKeys.length}`);

  // The historical bug: mark("FIRST LAUNCH") is NOT the canonical FIRST_LAUNCH
  // key — it silently adds an alias row while the canonical stays NOT RUN.
  const offCanonical = [...new Set(markedKeys.filter((key) => !canonicalKeys.includes(key)))];
  assert.deepEqual(
    offCanonical,
    [],
    `every mark()/pass() key must be a canonical report key — unknown keys: ${offCanonical.join(", ")}`,
  );

  // And every NOT RUN-initialized section must be REACHABLE by a mark: a
  // section nothing can mark would stay NOT RUN even on a perfect run.
  const notRunSections = entries.filter((entry) => entry.value === "NOT RUN").map((entry) => entry.key);
  const unmarkable = notRunSections.filter((key) => !markedKeys.includes(key));
  assert.deepEqual(
    unmarkable,
    [],
    `every NOT RUN section needs a mark() call site — unmarkable: ${unmarkable.join(", ")}`,
  );
});

test("a successful full run cannot leave completed sections marked NOT RUN (simulation over the real harness keys)", () => {
  const entries = parseReportInitializer(source);
  const markedKeys = parseMarkedKeys(source);

  // Build the report exactly as the harness initializes it…
  const report: Record<string, string> = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  // …then apply a PASS for every section the harness can mark (full success).
  for (const key of markedKeys) report[key] = "PASS";

  // With the spaced-alias bug, mark("FIRST LAUNCH") ADDED an alias key while
  // the canonical FIRST_LAUNCH stayed "NOT RUN" — this is that mechanism,
  // replayed against the actual source. On the fixed harness: nothing stuck.
  const stuck = Object.entries(report).filter(([, value]) => value === "NOT RUN");
  assert.deepEqual(
    stuck.map(([key]) => key),
    [],
    "a fully successful run must leave NO section at NOT RUN (keys never reached by any mark() call)",
  );

  // No alias rows either: the summary after a full run is exactly the
  // initialized keys, every completed one now PASS.
  assert.deepEqual(
    Object.keys(report).sort(),
    [...new Set([...entries.map((entry) => entry.key), ...markedKeys])].sort(),
    "marking must never add keys beyond the initialized report",
  );
});
