/**
 * Regression tests for the acceptance "data root" contract
 * (desktop/acceptance.ts evaluateDataRootStep).
 *
 * Second harness defect after 84bfdcf: the paths section hardcoded the
 * pre-isolation invariant "win32 && !portable => %LOCALAPPDATA%\Arena" and
 * therefore rejected the intentionally injected ARENA_DATA_DIR isolated
 * acceptance root (source: "env") on BOTH the normal and recovery launches,
 * cascading into PROCESS CLEANUP: FAIL via evaluateRecovery's required
 * paths section.
 *
 * The contract now validates the ACTIVE source:
 *   - win32 platform default MUST still be %LOCALAPPDATA%\Arena
 *     (production-default coverage — kept, not removed);
 *   - source "env" MUST equal the ARENA_DATA_DIR override (this is how the
 *     installed acceptance runs with an isolated fresh data root);
 *   - portable / other platforms keep the recorded-location behavior.
 *
 * Production data-directory behavior (resolveArenaDataDirs) is untouched and
 * separately covered by desktop/paths.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateDataRootStep } from "./acceptance";

const WIN_LOCAL = String.raw`C:\Users\lochi\AppData\Local`;

test("win32 platform default: %LOCALAPPDATA%\\Arena passes the acceptance contract", () => {
  const step = evaluateDataRootStep(
    { root: String.raw`C:\Users\lochi\AppData\Local\Arena`, source: "platform", portable: false },
    { LOCALAPPDATA: WIN_LOCAL },
    "win32",
  );
  assert.equal(step.name, "data root is %LOCALAPPDATA%\\Arena");
  assert.equal(step.ok, true, step.info);
});

test("win32 platform default coverage is real: any other root FAILS", () => {
  const step = evaluateDataRootStep(
    { root: String.raw`D:\SomewhereElse\Arena`, source: "platform", portable: false },
    { LOCALAPPDATA: WIN_LOCAL },
    "win32",
  );
  assert.equal(step.name, "data root is %LOCALAPPDATA%\\Arena");
  assert.equal(step.ok, false, "production resolution must keep proving the %LOCALAPPDATA% default");
});

test("win32 ARENA_DATA_DIR override: the isolated acceptance root passes", () => {
  const isolated = String.raw`C:\Users\lochi\AppData\Local\Temp\arena-acceptance-data-x7Q`;
  const step = evaluateDataRootStep(
    { root: isolated, source: "env", portable: false },
    { LOCALAPPDATA: WIN_LOCAL, ARENA_DATA_DIR: isolated },
    "win32",
  );
  assert.equal(step.name, "data root follows ARENA_DATA_DIR override");
  assert.equal(step.ok, true, step.info);
});

test("env source honesty guard: a root that is NOT the override FAILS", () => {
  const step = evaluateDataRootStep(
    { root: String.raw`C:\Users\lochi\AppData\Local\Arena`, source: "env", portable: false },
    { LOCALAPPDATA: WIN_LOCAL, ARENA_DATA_DIR: String.raw`C:\temp\arena-acceptance-data-a1` },
    "win32",
  );
  assert.equal(step.ok, false, "source env must actually follow ARENA_DATA_DIR");
});

test("env source without ARENA_DATA_DIR in the env record FAILS (never a silent pass)", () => {
  const step = evaluateDataRootStep(
    { root: String.raw`C:\temp\x`, source: "env", portable: false },
    { LOCALAPPDATA: WIN_LOCAL },
    "win32",
  );
  assert.equal(step.ok, false);
});

test("portable mode keeps the recorded-location behavior", () => {
  const step = evaluateDataRootStep(
    { root: String.raw`D:\ArenaPortable\arena-data`, source: "portable", portable: true },
    {},
    "win32",
  );
  assert.equal(step.name, "data root location recorded");
  assert.equal(step.ok, true);
  assert.match(step.info ?? "", /portable=true/);
});

test("non-win32 platform keeps the recorded-location behavior", () => {
  const step = evaluateDataRootStep(
    { root: "/home/lochi/.local/share/arena", source: "platform", portable: false },
    {},
    "linux",
  );
  assert.equal(step.name, "data root location recorded");
  assert.equal(step.ok, true);
});
