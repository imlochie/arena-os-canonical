/**
 * Installed-package smoke check for the current Vite + Express desktop app.
 *
 * Uses fresh temporary application data and writes only test statuses. Local
 * model inference and real-audio processing are intentionally not part of this
 * packaging check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import {
  createArenaBackup,
  restoreArenaBackup,
  verifyArenaBackup,
} from "./arena-backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(
  here,
  "../generated-artifacts/windows-package-smoke",
);
const reportPath = path.join(outputDir, "result.json");
const executable = process.argv[2];
const checkIds = [
  "installed_app_starts",
  "embedded_database_starts",
  "packaged_migrations_run",
  "bundled_ffmpeg_resolves",
  "bundled_ffprobe_resolves",
  "waveyard_capture_host_loads",
  "waveyard_capture_runtime_wired",
  "database_backup_restore_round_trip",
  "restored_record_opens_in_ui",
  "tampered_backup_rejected_in_data_menu",
  "original_data_usable_after_failed_restore",
];
const report = {
  passed: false,
  platform: process.platform,
  arch: process.arch,
  checks: checkIds.map((id) => ({ id, status: "not_run" })),
  modelDependent: "not_run",
  realAudio: "not_run",
};

let activeCheck = null;
let dataRoot = null;
let desktop = null;
let restoreRoot = null;
let damagedRestoreRoot = null;
let backupDir = null;

function begin(id) {
  activeCheck = id;
  report.checks.find((check) => check.id === id).status = "running";
}

function pass(id) {
  report.checks.find((check) => check.id === id).status = "passed";
  activeCheck = null;
}

async function run() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert(executable && path.isAbsolute(executable));

  const resources = path.join(path.dirname(executable), "resources");
  const binDir = path.join(resources, "bin");
  const migrationsDir = path.join(resources, "desktop-migrations");

  dataRoot = await mkdtemp(path.join(os.tmpdir(), "arenaforge-package-smoke-"));
  const env = {
    ...process.env,
    ARENA_DATA_DIR: dataRoot,
    APPDATA: path.join(dataRoot, "profile/roaming"),
    LOCALAPPDATA: path.join(dataRoot, "profile/local"),
  };
  delete env.ARENA_FFMPEG_PATH;
  delete env.ARENA_FFPROBE_PATH;
  delete env.ARENA_APP_BIN_DIR;

  begin("installed_app_starts");
  desktop = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${path.join(dataRoot, "electron-profile")}`],
    timeout: 150_000,
    env,
  });
  const page = await desktop.firstWindow({ timeout: 150_000 });
  await page.waitForURL("**/spaces", { timeout: 150_000 });
  await page
    .getByRole("heading", { name: "Browser tasks in private workspaces" })
    .waitFor();
  pass("installed_app_starts");

  const base = new URL(page.url()).origin;
  begin("embedded_database_starts");
  const response = await page.request.get(`${base}/api/capabilities`, {
    timeout: 30_000,
  });
  assert(response.ok());
  const capabilities = await response.json();
  const byId = new Map(
    capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  assert.equal(byId.get("database")?.status, "READY");
  pass("embedded_database_starts");

  begin("packaged_migrations_run");
  const packagedMigrations = (await readdir(migrationsDir)).filter((name) =>
    name.endsWith(".sql"),
  );
  assert(packagedMigrations.length > 0);
  const migrations = byId.get("migrations");
  assert.equal(migrations?.status, "READY");
  const migrationCount = Number(
    /^(\d+) applied$/.exec(migrations.version ?? "")?.[1],
  );
  assert.equal(migrationCount, packagedMigrations.length);
  pass("packaged_migrations_run");

  for (const tool of ["ffmpeg", "ffprobe"]) {
    const id = `bundled_${tool}_resolves`;
    begin(id);
    const entry = byId.get(tool);
    const expected = path.join(binDir, `${tool}.exe`);
    assert.equal(entry?.status, "READY");
    assert.equal(entry?.source, "bundled");
    assert.equal(
      path.resolve(entry.path).toLowerCase(),
      path.resolve(expected).toLowerCase(),
    );
    pass(id);
  }

  begin("waveyard_capture_host_loads");
  const captureHost = path.join(resources, "native", "waveyard-capture-host.exe");
  const captureHostResult = spawnSync(captureHost, ["version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(captureHostResult.error, undefined, captureHostResult.error?.message);
  assert.equal(captureHostResult.status, 0, captureHostResult.stderr);
  const captureProtocol = JSON.parse(captureHostResult.stdout.trim());
  assert.equal(captureProtocol.protocolVersion, 1);
  assert(captureProtocol.captureModes.includes("system-loopback"));
  assert(captureProtocol.captureModes.every((mode) => ["system-loopback", "process-loopback"].includes(mode)));
  pass("waveyard_capture_host_loads");

  begin("waveyard_capture_runtime_wired");
  const captureOptionsResponse = await page.request.get(
    `${base}/api/library/audio-capture`,
    { timeout: 15_000 },
  );
  assert(captureOptionsResponse.ok());
  const captureOptions = await captureOptionsResponse.json();
  assert.equal(typeof captureOptions.available, "boolean");
  assert(captureOptions.storage);
  assert(Number.isFinite(captureOptions.storage.availableBytes));
  assert.equal(captureOptions.storage.reserveBytes, 1024 ** 3);
  assert.equal(typeof captureOptions.storage.canRecord, "boolean");
  if (captureOptions.storage.canRecord) {
    assert.equal(typeof captureOptions.processLoopbackSupported, "boolean");
    assert(Array.isArray(captureOptions.applications));
    for (const app of captureOptions.applications) {
      assert(Number.isInteger(app.processId) && app.processId > 0);
      assert.match(app.processStartTime, /^[0-9]{1,20}$/);
      assert.equal(typeof app.name, "string");
    }
  }
  pass("waveyard_capture_runtime_wired");

  begin("database_backup_restore_round_trip");
  const sentinelTitle = `Backup round trip ${Date.now()}`;
  const sentinelPrompt = "Windows package backup acceptance record";
  const createdSpace = await page.request.post(`${base}/api/spaces`, {
    data: { title: sentinelTitle, prompt: sentinelPrompt },
    timeout: 20_000,
  });
  assert.equal(createdSpace.status(), 201);
  const sentinel = (await createdSpace.json()).space;
  assert(sentinel?.id);
  await desktop.close();
  desktop = null;
  const waveyardAudio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x11, 0x22, 0x33, 0x44]);
  const waveyardCapture = Buffer.from([0x00, 0x10, 0x20, 0x7f, 0x80, 0xff]);
  await mkdir(path.join(dataRoot, "waveyard/storage/acceptance"), { recursive: true });
  await mkdir(path.join(dataRoot, "waveyard/capture/acceptance"), { recursive: true });
  await writeFile(path.join(dataRoot, "waveyard/storage/acceptance/source.wav"), waveyardAudio);
  await writeFile(path.join(dataRoot, "waveyard/capture/acceptance/take.pcm"), waveyardCapture);
  const databaseCredential = JSON.parse(await readFile(path.join(dataRoot, "runtime/db-password.json"), "utf8"));
  const backup = await createArenaBackup({
    root: dataRoot,
    parentDir: path.dirname(dataRoot),
    passphrase: "Windows package smoke backup passphrase",
    databaseStopped: true,
    waveyardSelection: ["storage", "capture"],
  });
  assert.equal(backup.manifest.version, 2, "new backups must use the encrypted format");
  assert.equal(backup.manifest.includesWaveyardFiles, true);
  assert.deepEqual(backup.manifest.waveyardSelection, ["storage", "capture"]);
  assert(
    Object.keys(backup.manifest.files).every(relative => relative.startsWith("payload/")),
    "the public file list must not reveal original database or media paths",
  );
  const publicManifest = await readFile(path.join(backup.backupDir, "backup-manifest.json"), "utf8");
  assert(!publicManifest.includes("source.wav"));
  assert(!publicManifest.includes("take.pcm"));
  backupDir = backup.backupDir;
  restoreRoot = await mkdtemp(path.join(os.tmpdir(), "arenaforge-package-restore-"));
  await rm(restoreRoot, { recursive: true, force: true });
  await restoreArenaBackup({
    backupDir,
    targetRoot: restoreRoot,
    passphrase: "Windows package smoke backup passphrase",
  });
  assert.deepEqual(await readFile(path.join(restoreRoot, "waveyard/storage/acceptance/source.wav")), waveyardAudio);
  assert.deepEqual(await readFile(path.join(restoreRoot, "waveyard/capture/acceptance/take.pcm")), waveyardCapture);
  assert.equal(
    JSON.parse(await readFile(path.join(restoreRoot, "runtime/db-password.json"), "utf8")).password,
    databaseCredential.password,
  );
  desktop = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${path.join(restoreRoot, "electron-profile")}`],
    timeout: 150_000,
    env: {
      ...env,
      ARENA_DATA_DIR: restoreRoot,
      APPDATA: path.join(restoreRoot, "profile/roaming"),
      LOCALAPPDATA: path.join(restoreRoot, "profile/local"),
    },
  });
  const restoredPage = await desktop.firstWindow({ timeout: 150_000 });
  await restoredPage.waitForURL("**/spaces", { timeout: 150_000 });
  const restoredSpacesResponse = await restoredPage.request.get(`${new URL(restoredPage.url()).origin}/api/spaces`, {
    timeout: 20_000,
  });
  assert(restoredSpacesResponse.ok());
  const restoredSpaces = await restoredSpacesResponse.json();
  assert(
    restoredSpaces.spaces.some(space => space.id === sentinel.id && space.title === sentinelTitle),
    "Arena must start with the restored database and return the preserved record",
  );
  pass("database_backup_restore_round_trip");

  begin("restored_record_opens_in_ui");
  const restoredOrigin = new URL(restoredPage.url()).origin;
  await restoredPage.goto(`${restoredOrigin}/spaces/${sentinel.id}`, {
    waitUntil: "domcontentloaded",
  });
  await restoredPage.getByText(sentinelTitle, { exact: false }).waitFor({
    timeout: 15_000,
  });
  await restoredPage.getByRole("button", { name: /setup/i }).click();
  const restoredPrompt = restoredPage.getByLabel(/task prompt/i);
  await restoredPrompt.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await restoredPrompt.inputValue(),
    sentinelPrompt,
    "the restored Arena UI must load the record's saved prompt",
  );
  pass("restored_record_opens_in_ui");

  await desktop.close();
  desktop = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${path.join(dataRoot, "original-electron-profile")}`],
    timeout: 150_000,
    env,
  });
  const originalPage = await desktop.firstWindow({ timeout: 150_000 });
  await originalPage.waitForURL("**/spaces", { timeout: 150_000 });

  const encryptedPath = Object.keys(backup.manifest.files)[0];
  assert(encryptedPath, "the backup must contain an encrypted file to tamper with");
  const encryptedFile = path.join(backupDir, encryptedPath);
  const encryptedFileBytes = await readFile(encryptedFile);
  await writeFile(
    encryptedFile,
    Buffer.concat([encryptedFileBytes, Buffer.from([0])]),
  );
  const damagedBackup = await verifyArenaBackup(backupDir);
  assert.equal(damagedBackup.ok, false);
  assert(
    damagedBackup.mismatches.length > 0,
    "backup verification must identify the changed encrypted file",
  );

  damagedRestoreRoot = await mkdtemp(
    path.join(os.tmpdir(), "arenaforge-package-damaged-restore-"),
  );
  begin("tampered_backup_rejected_in_data_menu");
  const unlockWindowPromise = desktop.waitForEvent("window", {
    timeout: 15_000,
  });
  await desktop.evaluate(
    ({ app, BrowserWindow, dialog, Menu }, { backupDir, targetRoot }) => {
      const state = {
        openDialogCount: 0,
        confirmation: null,
        error: null,
        relaunchRequested: false,
        relaunchDataRoot: null,
        exitRequested: false,
      };
      globalThis.__arenaBackupSmokeDialogs = state;
      dialog.showOpenDialog = async (_window, options) => {
        state.openDialogCount += 1;
        return {
          canceled: false,
          filePaths: [
            state.openDialogCount === 1 ? backupDir : targetRoot,
          ],
        };
      };
      dialog.showMessageBox = async (_window, options) => {
        state.confirmation = options;
        return { response: 0 };
      };
      dialog.showErrorBox = (title, message) => {
        state.error = { title, message };
      };
      app.relaunch = (options) => {
        state.relaunchRequested = true;
        state.relaunchDataRoot = options?.env?.ARENA_DATA_DIR ?? null;
      };
      app.exit = () => {
        state.exitRequested = true;
      };

      const dataMenu = Menu.getApplicationMenu()?.getMenuItemByLabel("Data");
      const restoreItem = dataMenu?.submenu?.getMenuItemByLabel(
        "Restore backup to a new data folder…",
      );
      if (!restoreItem || typeof restoreItem.click !== "function") {
        throw new Error("The Arena Data menu restore item is unavailable.");
      }

      // Invoke the callback attached to the packaged app's real Data menu item.
      restoreItem.click(
        restoreItem,
        BrowserWindow.getFocusedWindow(),
        { type: "key" },
      );
    },
    { backupDir, targetRoot: damagedRestoreRoot },
  );

  const unlockWindow = await unlockWindowPromise;
  await unlockWindow.getByLabel("Backup passphrase").fill(
    "Windows package smoke backup passphrase",
  );
  await unlockWindow.getByRole("button", { name: "Continue" }).click();

  let restoreFailure = null;
  const failureDeadline = Date.now() + 45_000;
  while (Date.now() < failureDeadline) {
    restoreFailure = await desktop.evaluate(
      () => globalThis.__arenaBackupSmokeDialogs?.error ?? null,
    );
    if (restoreFailure) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(restoreFailure, "the Data menu must show a restore failure");
  assert.equal(restoreFailure.title, "Arena restore failed");
  assert.match(restoreFailure.message, /Backup verification failed/i);
  assert.match(restoreFailure.message, /changed/i);
  assert.match(restoreFailure.message, /current data folder was not overwritten/i);
  const restoreDialogState = await desktop.evaluate(
    () => globalThis.__arenaBackupSmokeDialogs,
  );
  assert.equal(restoreDialogState.openDialogCount, 2);
  assert.match(
    restoreDialogState.confirmation.detail,
    /current Arena data folder will not be overwritten/i,
  );
  assert.equal(restoreDialogState.relaunchRequested, true);
  assert.equal(
    path.resolve(restoreDialogState.relaunchDataRoot),
    path.resolve(dataRoot),
    "a rejected backup must relaunch Arena with its original data folder",
  );
  assert.equal(restoreDialogState.exitRequested, true);
  assert.deepEqual(
    await readdir(damagedRestoreRoot),
    [],
    "a rejected backup must not create partial data in the selected destination",
  );
  pass("tampered_backup_rejected_in_data_menu");

  await desktop.close();
  desktop = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${path.join(dataRoot, "verified-original-profile")}`],
    timeout: 150_000,
    env,
  });
  const verifiedOriginalPage = await desktop.firstWindow({ timeout: 150_000 });
  await verifiedOriginalPage.waitForURL("**/spaces", { timeout: 150_000 });
  const originalOrigin = new URL(verifiedOriginalPage.url()).origin;
  const originalSpacesResponse = await verifiedOriginalPage.request.get(
    `${originalOrigin}/api/spaces`,
    { timeout: 20_000 },
  );
  assert(originalSpacesResponse.ok());
  const originalSpaces = await originalSpacesResponse.json();
  const originalRecord = originalSpaces.spaces.find(
    (space) => space.id === sentinel.id,
  );
  assert.equal(originalRecord?.title, sentinelTitle);
  await verifiedOriginalPage.goto(`${originalOrigin}/spaces/${sentinel.id}`, {
    waitUntil: "domcontentloaded",
  });
  await verifiedOriginalPage.getByRole("button", { name: /setup/i }).click();
  const originalPrompt = verifiedOriginalPage.getByLabel(/task prompt/i);
  await originalPrompt.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await originalPrompt.inputValue(),
    sentinelPrompt,
    "the original Arena record must remain usable and unchanged",
  );
  assert.deepEqual(
    await readFile(path.join(dataRoot, "waveyard/storage/acceptance/source.wav")),
    waveyardAudio,
  );
  assert.deepEqual(
    await readFile(path.join(dataRoot, "waveyard/capture/acceptance/take.pcm")),
    waveyardCapture,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(dataRoot, "runtime/db-password.json"), "utf8")).password,
    databaseCredential.password,
  );
  pass("original_data_usable_after_failed_restore");

  report.passed = true;
}

try {
  await run();
  console.log("Installed Windows package smoke check passed.");
} catch {
  const failedCheck = activeCheck ?? "installed_app_starts";
  const check = report.checks.find((entry) => entry.id === failedCheck);
  if (check) check.status = "failed";
  report.failedCheck = failedCheck;
  console.error(
    `Installed Windows package smoke check failed: ${failedCheck}.`,
  );
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  if (dataRoot)
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  if (restoreRoot)
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => {});
  if (damagedRestoreRoot)
    await rm(damagedRestoreRoot, { recursive: true, force: true }).catch(() => {});
  if (backupDir)
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("Result: generated-artifacts/windows-package-smoke/result.json");
}
