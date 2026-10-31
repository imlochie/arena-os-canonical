/**
 * Installed-package smoke check for the current Vite + Express desktop app.
 *
 * Uses fresh temporary application data and writes only test statuses. Local
 * model inference and real-audio processing are intentionally not part of this
 * packaging check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

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
  const env = { ...process.env, ARENA_DATA_DIR: dataRoot };
  delete env.ARENA_FFMPEG_PATH;
  delete env.ARENA_FFPROBE_PATH;
  delete env.ARENA_APP_BIN_DIR;

  begin("installed_app_starts");
  desktop = await _electron.launch({
    executablePath: executable,
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
  assert.deepEqual(captureProtocol.captureModes, ["system-loopback"]);
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
  pass("waveyard_capture_runtime_wired");

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
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("Result: generated-artifacts/windows-package-smoke/result.json");
}
