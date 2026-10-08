/**
 * Installed-acceptance data isolation.
 *
 * Fix for the Windows acceptance failure where FIRST LAUNCH failed with
 * `firstRun=false`: scripts/windows-acceptance.mjs previously derived the
 * REAL user data directory (%LOCALAPPDATA%\Arena), passed no ARENA_DATA_DIR
 * to the installed app, and pointed findOwnedProcesses() at the real data
 * dir — so repeated acceptance runs reused existing Arena state and the
 * supposedly-fresh first launch was anything but.
 *
 * The contract in this module (regression-tested in
 * desktop/acceptance-data-root.test.ts and desktop/windows-acceptance-harness.test.ts):
 *
 *   - every acceptance run creates a GENUINELY FRESH temporary data root
 *     (mkdtemp — no pre-existing cluster, so initdb must run and the first
 *     launch reports firstRun=true);
 *   - the SAME root is shared by the normal first launch (restart
 *     persistence runs inside it), the abnormal-shutdown run, and the
 *     recovery launch — recovery must prove persistence/recovery, never
 *     re-initialisation;
 *   - production path defaults are untouched: resolveArenaDataDirs still
 *     defaults to %LOCALAPPDATA%\Arena on win32 when ARENA_DATA_DIR is
 *     absent (the override simply wins when present);
 *   - cleanup removes ONLY roots created by this module (marker-guarded),
 *     so the harness can structurally never delete the user's real
 *     %LOCALAPPDATA%\Arena.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

 /** Marks a directory as an acceptance-created data root. Present ONLY in
 * roots created by createAcceptanceDataRoot — the real user data directory
 * never has it, which is what makes destructive cleanup safe. The name is
 * part of the cleanup contract (stability is regression-tested). */
export const MARKER_FILE_NAME = ".arena-acceptance-data-root";
const MARKER_FILE = MARKER_FILE_NAME;

/** Create a fresh, isolated acceptance data root. mkdtemp guarantees a
 * directory that did not exist a moment ago — therefore no database
 * cluster, no state, a genuinely fresh first launch. */
export function createAcceptanceDataRoot(tmpBase: string = tmpdir()): string {
  const root = mkdtempSync(path.join(tmpBase, "arena-acceptance-data-"));
  writeFileSync(path.join(root, MARKER_FILE), `${new Date().toISOString()}\n`);
  return root;
}

/** True only for roots created by createAcceptanceDataRoot. */
export function isAcceptanceDataRoot(dir: string): boolean {
  try {
    return existsSync(path.join(dir, MARKER_FILE));
  } catch {
    return false;
  }
}

/** The env the installed app needs to run in acceptance mode against an
 * isolated data root. ARENA_DATA_DIR is honored by production
 * resolveArenaDataDirs (absolute paths required); ARENA_DESKTOP_ACCEPTANCE
 * points the in-app acceptance runner at its result file. */
export interface AcceptanceLaunchEnv {
  ARENA_DATA_DIR: string;
  ARENA_DESKTOP_ACCEPTANCE: string;
}

export function acceptanceLaunchEnv(dataRoot: string, resultPath: string): AcceptanceLaunchEnv {
  return { ARENA_DATA_DIR: dataRoot, ARENA_DESKTOP_ACCEPTANCE: resultPath };
}

// ------------------------------------------------------ installed launches

export const INSTALLED_ACCEPTANCE_PHASES = ["normal", "abnormal", "recovery"] as const;
export type InstalledAcceptancePhase = (typeof INSTALLED_ACCEPTANCE_PHASES)[number];

const RESULT_FILE_NAMES: Record<InstalledAcceptancePhase, string> = {
  normal: "run1.json",
  abnormal: "abnormal.json",
  recovery: "recovery.json",
};

export interface InstalledAcceptanceLaunch {
  phase: InstalledAcceptancePhase;
  resultPath: string;
  env: AcceptanceLaunchEnv;
}

export interface InstalledAcceptanceLaunchPlan {
  dataRoot: string;
  launches: Record<InstalledAcceptancePhase, InstalledAcceptanceLaunch>;
}

/**
 * The full installed-app launch contract: ONE isolated data root shared by
 *   - normal   — the first launch; the in-app restart-persistence section
 *                cycles the supervisor INSIDE this same process/root;
 *   - abnormal — the force-killed run;
 *   - recovery — the launch after the abnormal shutdown, which must find
 *                the SAME cluster (firstRun=false, data intact) and is
 *                judged by the recovery verdict, never by first-launch
 *                invariants.
 */
export function planInstalledAcceptanceLaunches(input: {
  dataRoot: string;
  resultDir: string;
}): InstalledAcceptanceLaunchPlan {
  const launches = {} as Record<InstalledAcceptancePhase, InstalledAcceptanceLaunch>;
  for (const phase of INSTALLED_ACCEPTANCE_PHASES) {
    const resultPath = path.join(input.resultDir, RESULT_FILE_NAMES[phase]);
    launches[phase] = { phase, resultPath, env: acceptanceLaunchEnv(input.dataRoot, resultPath) };
  }
  return { dataRoot: input.dataRoot, launches };
}

// ---------------------------------------------------------------- cleanup

/**
 * Remove an acceptance data root. Marker-guarded: a directory without the
 * acceptance marker (e.g. the user's REAL %LOCALAPPDATA%\Arena) is refused,
 * never deleted. Retries with a delay cover Windows file locks; the caller
 * is expected to have killed owned processes first. Returns whether the
 * root was fully removed.
 */
export async function removeAcceptanceDataRoot(
  dir: string,
  attempts = 6,
  delayMs = 500,
): Promise<boolean> {
  if (!isAcceptanceDataRoot(dir)) return false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return false;
}

/** Test/diagnostics helper: the contents of a freshly created root (only
 * the marker — proving there is no database state in it). */
export function acceptanceDataRootContents(dir: string): string[] {
  return readdirSync(dir).sort();
}
