/**
 * Regression tests for the installed-acceptance data isolation contract
 * (fix for the Windows acceptance failure: FIRST LAUNCH · firstRun=false
 * because the harness reused the real %LOCALAPPDATA%\Arena state).
 *
 * Proves:
 *   1. every acceptance run gets a GENUINELY FRESH data root (no database
 *      state in it → initdb must run → firstRun=true);
 *   2. normal / abnormal / recovery launches all reuse the SAME data root
 *      (recovery proves persistence, not re-initialisation);
 *   3. production path defaults are untouched — %LOCALAPPDATA%\Arena on
 *      win32 when ARENA_DATA_DIR is absent; the override wins when present;
 *   4. cleanup is marker-guarded — the real user data directory can
 *      structurally never be removed by the harness.
 *
 * The runtime-level proof (firstRun=true on a fresh ARENA_DATA_DIR, then
 * firstRun=false on restart against the SAME root) is exercised end-to-end
 * by scripts/desktop-e2e.mjs ("first run initialised the database cluster"
 * + "restart does NOT re-initdb") and by desktop-acceptance-headless.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MARKER_FILE_NAME,
  acceptanceDataRootContents,
  acceptanceLaunchEnv,
  createAcceptanceDataRoot,
  isAcceptanceDataRoot,
  planInstalledAcceptanceLaunches,
  removeAcceptanceDataRoot,
} from "./acceptance-data-root";
import { resolveArenaDataDirs } from "./paths";

test("acceptance data root: genuinely fresh per run (isolated, no database state)", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "acceptance-root-test-"));
  try {
    const a = createAcceptanceDataRoot(base);
    const b = createAcceptanceDataRoot(base);
    assert.ok(path.isAbsolute(a) && path.isAbsolute(b), "must be absolute (ARENA_DATA_DIR requires it)");
    assert.notEqual(a, b, "every acceptance run gets its own fresh root");
    assert.ok(existsSync(a) && existsSync(b));
    // Fresh = nothing but the marker: no postgres cluster, no app state —
    // the first launch against this root MUST initialise the cluster.
    assert.deepEqual(acceptanceDataRootContents(a), [".arena-acceptance-data-root"]);
    assert.equal(isAcceptanceDataRoot(a), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("launch plan: normal, abnormal, and recovery ALL reuse the SAME data root", () => {
  const dataRoot = createAcceptanceDataRoot();
  const resultDir = path.join(tmpdir(), "results-dir");
  const plan = planInstalledAcceptanceLaunches({ dataRoot, resultDir });

  for (const phase of ["normal", "abnormal", "recovery"] as const) {
    const launch = plan.launches[phase];
    assert.equal(launch.phase, phase);
    assert.equal(launch.env.ARENA_DATA_DIR, dataRoot, `${phase} must reuse the same data root`);
    assert.ok(path.isAbsolute(launch.env.ARENA_DATA_DIR));
    assert.ok(launch.resultPath.startsWith(resultDir + path.sep), `${phase} result under the result dir`);
  }
  // Result files keep the harness's established names.
  assert.equal(plan.launches.normal.resultPath, path.join(resultDir, "run1.json"));
  assert.equal(plan.launches.abnormal.resultPath, path.join(resultDir, "abnormal.json"));
  assert.equal(plan.launches.recovery.resultPath, path.join(resultDir, "recovery.json"));
  // The env carries exactly the two contract variables.
  assert.deepEqual(Object.keys(acceptanceLaunchEnv(dataRoot, path.join(resultDir, "run1.json"))).sort(), [
    "ARENA_DATA_DIR",
    "ARENA_DESKTOP_ACCEPTANCE",
  ]);
});

test("production defaults untouched: %LOCALAPPDATA%\\Arena on win32 without override; override wins when present", () => {
  const winLocal = "C:\\Users\\tester\\AppData\\Local";
  // No ARENA_DATA_DIR → the production default (this is the user's REAL
  // data dir — exactly what the acceptance harness must never touch).
  const production = resolveArenaDataDirs(
    { platform: "win32", env: { LOCALAPPDATA: winLocal }, fileExists: () => false },
    path.win32,
  );
  assert.ok(production.root.endsWith(path.win32.join("AppData", "Local", "Arena")), production.root);
  assert.equal(production.source, "platform");

  // ARENA_DATA_DIR present → the isolated acceptance root wins.
  const dataRoot = createAcceptanceDataRoot();
  try {
    const isolated = resolveArenaDataDirs(
      { platform: "win32", env: { LOCALAPPDATA: winLocal, ARENA_DATA_DIR: dataRoot }, fileExists: () => false },
      path.win32,
    );
    // The env override wins verbatim (on Windows the tmp root is already a
    // win32 path, so this is an exact match; the resolve() accounts for the
    // Linux test host normalizing separators under win32 path ops).
    assert.equal(isolated.root, path.win32.resolve(dataRoot));
    assert.equal(isolated.source, "env");
    assert.notEqual(isolated.root.toLowerCase(), production.root.toLowerCase(), "acceptance state must never be the real data dir");
  } finally {
    void removeAcceptanceDataRoot(dataRoot);
  }
});

test("cleanup is marker-guarded: only acceptance-created roots are removed", async () => {
  // A real user-style data dir (no marker) must NEVER be deleted.
  const realStyle = mkdtempSync(path.join(tmpdir(), "arena-real-style-"));
  const canary = path.join(realStyle, "postgres-data.txt");
  await import("node:fs").then((fs) => fs.writeFileSync(canary, "user data"));
  assert.equal(await removeAcceptanceDataRoot(realStyle), false, "non-acceptance dir is refused");
  assert.ok(existsSync(canary), "the real data dir must be untouched");

  // An acceptance root IS removed.
  const acceptance = createAcceptanceDataRoot();
  assert.equal(await removeAcceptanceDataRoot(acceptance), true);
  assert.ok(!existsSync(acceptance));

  // Missing directories and non-root inputs are refused without throwing.
  assert.equal(await removeAcceptanceDataRoot(path.join(tmpdir(), "does-not-exist-arena")), false);

  rmSync(realStyle, { recursive: true, force: true });
});

test("marker name stays stable (the guard depends on it)", () => {
  assert.equal(MARKER_FILE_NAME, ".arena-acceptance-data-root");
});
