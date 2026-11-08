/**
 * Verify a Windows package update against an isolated older installation.
 * The report contains test statuses only; no app data or record values.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(
  here,
  "../generated-artifacts/windows-package-update-smoke",
);
const reportPath = path.join(outputDir, "result.json");
const previousInstaller = process.argv[2];
const currentInstaller = process.argv[3];
const checkIds = [
  "older_package_installs",
  "older_package_starts",
  "older_package_migrations_applied",
  "test_record_created",
  "older_package_closes_cleanly",
  "current_package_installs_over_existing",
  "current_package_starts",
  "test_record_preserved",
  "current_packaged_migrations_applied",
  "current_package_closes_cleanly",
];
const report = {
  passed: false,
  checks: checkIds.map((id) => ({ id, status: "not_run" })),
};

async function dumpChromiumLog() {
  const text = await readFile(path.join(testRoot ?? "", "chromium.log"), "utf8").catch(() => null);
  console.error("--- chromium.log (last 80 lines) ---");
  console.error(text === null ? "(not present)" : text.trim().split("\n").slice(-80).join("\n"));
}

async function dumpLogs() {
  // Application and database logs only; no record values are written to them.
  for (const name of ["desktop.log", "postgres.log"]) {
    const text = await readFile(path.join(dataRoot ?? "", "logs", name), "utf8").catch(() => null);
    console.error(`--- ${name} (last 60 lines) ---`);
    console.error(text === null ? "(not present)" : text.trim().split("\n").slice(-60).join("\n"));
  }
}

// What the main process knows about its windows and processes when a launch
// produced no usable page: distinguishes "no window", "renderer crashed" and
// "renderer busy-looping" without touching application state.
async function dumpWindowState() {
  if (!desktop) return;
  console.error("--- window state ---");
  const state = await Promise.race([
    desktop.evaluate(({ BrowserWindow, app }) => ({
      windows: BrowserWindow.getAllWindows().map((win) => ({
        url: win.webContents.getURL(),
        loading: win.webContents.isLoading(),
        crashed: win.webContents.isCrashed(),
        visible: win.isVisible(),
      })),
      processes: app.getAppMetrics().map((metric) => ({
        type: metric.type, pid: metric.pid, cpu: metric.cpu.percentCPUUsage,
      })),
    })).catch((error) => `evaluate failed: ${error.message}`),
    new Promise((resolve) => setTimeout(() => resolve("evaluate timed out after 20s"), 20_000)),
  ]);
  console.error(typeof state === "string" ? state : JSON.stringify(state, null, 1));
}

let activeCheck = null;
let testRoot;
let dataRoot;
let desktop;

function begin(id) {
  activeCheck = id;
  report.checks.find((check) => check.id === id).status = "running";
}

function pass(id) {
  report.checks.find((check) => check.id === id).status = "passed";
  activeCheck = null;
}

function install(installer, installDir) {
  const result = spawnSync(installer, ["/S", `/D=${installDir}`], {
    timeout: 180_000,
    windowsHide: true,
    stdio: "ignore",
  });
  assert.equal(result.error, undefined, `installer error: ${result.error}`);
  assert.equal(result.status, 0, `installer ${installer} exited ${result.status} signal ${result.signal}`);
}

async function launch(executable, profileDir) {
  desktop = await _electron.launch({
    executablePath: executable,
    args: [
      `--user-data-dir=${profileDir}`,
      // Chromium's own log is the only record of why a navigation never
      // commits; the application log stops once the server has answered.
      "--enable-logging=file",
      `--log-file=${path.join(testRoot, "chromium.log")}`,
      "--log-level=0",
    ],
    timeout: 150_000,
    env: {
      ...process.env,
      ARENA_DATA_DIR: dataRoot,
      APPDATA: path.join(testRoot, "profile/roaming"),
      LOCALAPPDATA: path.join(testRoot, "profile/local"),
    },
  });
  const page = await desktop.firstWindow({ timeout: 150_000 });
  await page.waitForURL("**/spaces", { timeout: 150_000 });
  await page
    .getByRole("heading", { name: "Browser tasks in private workspaces" })
    .waitFor();
  return page;
}

async function verifyMigrations(page, executable) {
  const base = new URL(page.url()).origin;
  const response = await page.request.get(`${base}/api/capabilities`, {
    timeout: 30_000,
  });
  assert(response.ok());
  const payload = await response.json();
  const capabilities = new Map(
    payload.capabilities.map((entry) => [entry.id, entry]),
  );
  assert.equal(capabilities.get("database")?.status, "READY");
  assert.equal(capabilities.get("migrations")?.status, "READY");
  const migrationCount = Number(
    /^(\d+) applied$/.exec(capabilities.get("migrations")?.version ?? "")?.[1],
  );
  const packagedMigrations = (
    await readdir(
      path.join(path.dirname(executable), "resources", "desktop-migrations"),
    )
  ).filter((name) => name.endsWith(".sql"));
  assert(packagedMigrations.length > 0);
  assert.equal(migrationCount, packagedMigrations.length);
}

async function closeCleanly() {
  const current = desktop;
  assert(current);
  await current.close();
  desktop = null;
  const pidFile = path.join(dataRoot, "data", "postgres", "postmaster.pid");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await access(pidFile);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      assert.equal(error.code, "ENOENT");
      return;
    }
  }
  assert.fail("The embedded database did not stop cleanly.");
}

async function run() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert(previousInstaller && path.isAbsolute(previousInstaller));
  assert(currentInstaller && path.isAbsolute(currentInstaller));

  testRoot = await mkdtemp(path.join(os.tmpdir(), "arenaforge-update-smoke-"));
  dataRoot = path.join(testRoot, "arena-data");
  const installDir = path.join(testRoot, "installation");
  const profileDir = path.join(testRoot, "electron-profile");

  begin("older_package_installs");
  install(previousInstaller, installDir);
  const executable = path.join(installDir, "ArenaForge.exe");
  await access(executable);
  pass("older_package_installs");

  begin("older_package_starts");
  const oldPage = await launch(executable, profileDir);
  pass("older_package_starts");

  begin("older_package_migrations_applied");
  await verifyMigrations(oldPage, executable);
  pass("older_package_migrations_applied");

  begin("test_record_created");
  const base = new URL(oldPage.url()).origin;
  const created = await oldPage.request.post(`${base}/api/spaces`, {
    data: {
      title: `Package update check ${Date.now()}`,
      prompt: "Temporary Windows package update test record.",
    },
    timeout: 20_000,
  });
  assert.equal(created.status(), 201);
  const recordId = (await created.json()).space?.id;
  assert(recordId);
  pass("test_record_created");

  begin("older_package_closes_cleanly");
  await closeCleanly();
  pass("older_package_closes_cleanly");

  begin("current_package_installs_over_existing");
  install(currentInstaller, installDir);
  await access(executable);
  pass("current_package_installs_over_existing");

  begin("current_package_starts");
  const currentPage = await launch(executable, profileDir);
  pass("current_package_starts");

  begin("test_record_preserved");
  const currentBase = new URL(currentPage.url()).origin;
  const spacesResponse = await currentPage.request.get(
    `${currentBase}/api/spaces`,
    { timeout: 20_000 },
  );
  assert(spacesResponse.ok());
  const spaces = await spacesResponse.json();
  assert(spaces.spaces.some((space) => space.id === recordId));
  pass("test_record_preserved");

  begin("current_packaged_migrations_applied");
  await verifyMigrations(currentPage, executable);
  pass("current_packaged_migrations_applied");

  begin("current_package_closes_cleanly");
  await closeCleanly();
  pass("current_package_closes_cleanly");
  report.passed = true;
}

try {
  await run();
  console.log("Windows package update check passed.");
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  await dumpWindowState();
  await dumpChromiumLog();
  await dumpLogs();
  const failedCheck = activeCheck ?? "older_package_starts";
  const check = report.checks.find((entry) => entry.id === failedCheck);
  if (check) check.status = "failed";
  report.failedCheck = failedCheck;
  console.error(`Windows package update check failed: ${failedCheck}.`);
  process.exitCode = 1;
} finally {
  if (desktop) {
    // A launch that never produced a window can leave close() waiting forever.
    const closed = await Promise.race([
      desktop.close().then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
    ]);
    if (!closed) {
      spawnSync("taskkill", ["/F", "/T", "/IM", "ArenaForge.exe"], { windowsHide: true });
      spawnSync("taskkill", ["/F", "/T", "/IM", "postgres.exe"], { windowsHide: true });
    }
  }
  if (testRoot) {
    const pidFile = path.join(
      testRoot,
      "arena-data",
      "data",
      "postgres",
      "postmaster.pid",
    );
    const safeToRemove = await access(pidFile).then(
      () => false,
      (error) => error.code === "ENOENT",
    );
    if (safeToRemove)
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    "Result: generated-artifacts/windows-package-update-smoke/result.json",
  );
}
