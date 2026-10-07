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
