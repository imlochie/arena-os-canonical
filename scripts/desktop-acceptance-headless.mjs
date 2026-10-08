/**
 * Headless pre-flight for the installed-app acceptance runner.
 *
 * Runs desktop/acceptance.ts — the EXACT code the installed Windows app runs
 * when launched with ARENA_DESKTOP_ACCEPTANCE — against the staged package
 * tree (desktop-package/) with an isolated temp data dir. This keeps the
 * runner honest in CI on any OS; the Windows machine then proves the same
 * runner against the real installer layout, real %LOCALAPPDATA%, and the
 * Electron binary as the Node runtime.
 *
 * Prerequisites: npm run desktop:prepare-server (staged tree must exist).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { repoRootFromMeta } from "./lib/repo-root.mjs";
import { verifyStagedPackage } from "./lib/staged-identity.mjs";

const root = repoRootFromMeta(import.meta.url);
const appRoot = path.join(root, "desktop-package");
// Same contract as desktop:e2e: never test a staged package that was not
// built from the current source state (stale-tree 404s, 6f0be59).
const identity = verifyStagedPackage({ root, packageRoot: appRoot });
if (!identity.ok) {
  console.error(`[acceptance-headless] ${identity.reason}`);
  process.exit(1);
}

const { runDesktopAcceptance } = await import(path.join(root, "desktop", "acceptance.ts"));
const { removeDirWithRetry } = await import(path.join(root, "desktop", "runtime", "fs-cleanup.ts"));
const { resolveArenaDataDirs } = await import(path.join(root, "desktop", "paths.ts"));

const dataRoot = mkdtempSync(path.join(tmpdir(), "arena-acceptance-"));
const reportPath = path.join(root, "desktop-acceptance-headless-report.json");
const logs = [];
const logger = {
  info: (scope, message, detail) => logs.push(`${new Date().toISOString()} INFO ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
  warn: (scope, message, detail) => logs.push(`${new Date().toISOString()} WARN ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
  error: (scope, message, detail) => logs.push(`${new Date().toISOString()} ERROR ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
};

const dirs = resolveArenaDataDirs({
  platform: process.platform,
  env: { ...process.env, ARENA_DATA_DIR: dataRoot },
  homeDir: tmpdir(),
  fileExists: existsSync,
});

try {
  const report = await runDesktopAcceptance({
    appRoot,
    dirs,
    nodeBinary: process.execPath,
    serverMode: "packaged",
    platform: process.platform,
    resultPath: reportPath,
    logger,
    env: { ...process.env },
  });

  for (const [name, section] of Object.entries(report.sections)) {
    for (const step of section.steps) {
      console.log(`[${step.ok ? "PASS" : "FAIL"}] ${name} · ${step.name}${step.info !== undefined ? ` — ${step.info}` : ""}`);
    }
  }
  if (report.error !== undefined) console.error(`[FAIL] runner error: ${report.error}`);
  console.log(report.ok ? "ACCEPTANCE HEADLESS PASSED" : "ACCEPTANCE HEADLESS FAILED");
  process.exitCode = report.ok ? 0 : 1;
} finally {
  // Keep the report for inspection; the temp data dir is disposable.
  try {
    const existing = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : {};
    writeFileSync(reportPath, JSON.stringify({ ...existing, harnessLogs: logs.slice(-200) }, null, 2));
  } catch {
    /* report already written by the runner */
  }
  // Windows-safe: retry transient handle lag AFTER the runner stopped PG.
  await removeDirWithRetry(dataRoot);
}
