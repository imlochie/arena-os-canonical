import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUILD_MIN_FREE_GIB,
  inspectBuildSpace,
  minimumFreeGiBForPreviousBuild,
  parseMinimumFreeGiB,
  resolvePnpmStorePath,
} from "./build-space-preflight.mjs";
import { summarizeBuildSpaceMeasurement } from "./build-space-measurement.mjs";

const GiB = 1024 ** 3;

test("installed pinned pnpm resolves a configured store without enabling downloads", () => {
  const calls = [];
  const store = resolvePnpmStorePath({
    platform: "win32",
    cwd: "C:\\Arena",
    env: { npm_config_store_dir: "D:\\Custom Store", NPM_CONFIG_OFFLINE: "false" },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: args.includes("--version") ? "10.26.1\r\n" : "D:\\Custom Store\\v10\r\n" };
    },
  });
  assert.equal(store, "D:\\Custom Store\\v10");
  assert.deepEqual(calls.map(({ command }) => command), ["pnpm", "pnpm"]);
  assert.deepEqual(calls[1].args, ["--config.manage-package-manager-versions=false", "store", "path"]);
  assert.equal(calls[1].options.cwd, "C:\\Arena");
  assert.equal(calls[1].options.env.npm_config_store_dir, "D:\\Custom Store");
  assert.equal(calls[1].options.env.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(calls[1].options.env.npm_config_offline, "true");
  assert.equal(calls[1].options.env.NPM_CONFIG_OFFLINE, undefined);
  assert.equal(calls[0].options.env.npm_config_manage_package_manager_versions, "false");
});

test("a missing or different installed pnpm uses only the pinned offline cache", () => {
  for (const version of [null, "9.0.0"]) {
    const calls = [];
    assert.equal(resolvePnpmStorePath({
      platform: "win32",
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return command === "pnpm"
          ? { status: version ? 0 : 1, stdout: version }
          : { status: 0, stdout: "E:\\pnpm\\store\\v10\n" };
      },
    }), "E:\\pnpm\\store\\v10");
    assert.equal(calls[1].command, "npx.cmd");
    assert.deepEqual(calls[1].args.slice(0, 3), ["--offline", "--yes", "pnpm@10.26.1"]);
    assert.equal(calls[1].options.env.COREPACK_ENABLE_NETWORK, "0");
  }
});

test("unavailable offline pnpm and invalid store output fail closed", () => {
  for (const result of [
    { status: 1, stdout: "" },
    { status: null, error: new Error("unavailable") },
    { status: 0, stdout: "relative\\store" },
    { status: 0, stdout: "D:\\store\nunexpected output" },
  ]) {
    assert.throws(() => resolvePnpmStorePath({
      platform: "win32",
      run: (_command, args) => args.includes("--version")
        ? { status: 0, stdout: "10.26.1" }
        : result,
    }), /No dependency download has started/);
  }
});

test("a custom store on another drive is checked even before the store exists", () => {
  const checked = [];
  const locations = inspectBuildSpace([
    { label: "workspace", path: "C:\\Arena" },
    { label: "pnpm dependency store", path: "D:\\Custom Store\\v10" },
  ], {
    pathApi: path.win32,
    exists: (target) => ["C:\\", "D:\\"].includes(target),
    statfs: (target) => {
      checked.push(target);
      return { bsize: 1, bavail: (target === "D:\\" ? 7 : 30) * GiB };
    },
  });
  assert.deepEqual(checked, ["C:\\", "D:\\"]);
  assert.equal(locations[0].belowMinimumFreeSpace, false);
  assert.equal(locations[1].availableGiB, 7);
  assert.equal(locations[1].belowMinimumFreeSpace, true);
  assert.equal(locations[1].path, "D:\\Custom Store\\v10");
});

test("an unavailable store drive is not silently replaced by the workspace drive", () => {
  const [store] = inspectBuildSpace([
    { label: "pnpm dependency store", path: "Z:\\offline-store\\v10" },
  ], {
    pathApi: path.win32,
    exists: () => false,
    statfs: () => assert.fail("An unavailable volume must not be measured elsewhere"),
  });
  assert.equal(store.availableBytes, null);
  assert.equal(store.belowMinimumFreeSpace, true);
  assert.match(store.inspectionError, /No existing parent/);
});

test("sampled reports retain consumption on the custom dependency-store drive", () => {
  const report = summarizeBuildSpaceMeasurement({
    initialLocations: [
      { label: "workspace", availableBytes: 40 * GiB },
      { label: "pnpm dependency store", availableBytes: 30 * GiB },
    ],
    samples: [{
      phase: "dependencies-installed",
      checkpoint: true,
      locations: [
        { label: "workspace", freeBytes: 39 * GiB },
        { label: "pnpm dependency store", freeBytes: 24 * GiB },
      ],
    }],
  });
  const store = report.locations.find(({ label }) => label === "pnpm dependency store");
  assert.equal(store.peakPhase, "dependencies-installed");
  assert.equal(report.measuredPeakConsumptionGiB, 6);
});

test("reports free space for each build location without modifying it", () => {
  const checked = [];
  const locations = inspectBuildSpace(
    [
      { label: "workspace", path: "C:\\Arena" },
      { label: "temporary files", path: "D:\\Temp" },
    ],
    {
      statfs: (location) => {
        checked.push(location);
        return { bsize: 1, bavail: 30 * GiB, bfree: 31 * GiB };
      },
    },
  );
  assert.equal(checked.length, 2);
  assert.deepEqual(locations.map(({ label, availableGiB, belowMinimumFreeSpace }) => ({
    label,
    availableGiB,
    belowMinimumFreeSpace,
  })), [
    { label: "workspace", availableGiB: 30, belowMinimumFreeSpace: false },
    { label: "temporary files", availableGiB: 30, belowMinimumFreeSpace: false },
  ]);
});

test("marks low-space locations as insufficient", () => {
  const [location] = inspectBuildSpace(
    [{ label: "workspace", path: "C:\\Arena" }],
    { statfs: () => ({ bsize: 1, bavail: 8 * GiB }), minimumFreeGiB: 20 },
  );
  assert.equal(location.belowMinimumFreeSpace, true);
  assert.equal(DEFAULT_BUILD_MIN_FREE_GIB, 20);
});

test("uses total free blocks when unprivileged free blocks are unavailable", () => {
  const [location] = inspectBuildSpace(
    [{ label: "workspace", path: "C:\\Arena" }],
    { statfs: () => ({ bsize: 1, bfree: 24 * GiB }) },
  );
  assert.equal(location.availableGiB, 24);
  assert.equal(location.belowMinimumFreeSpace, false);
});

test("an unreadable build location is treated as insufficient", () => {
  const [location] = inspectBuildSpace(
    [{ label: "user caches", path: "C:\\Users\\Owner\\AppData\\Local" }],
    { statfs: () => { throw new Error("volume unavailable"); } },
  );
  assert.equal(location.availableGiB, null);
  assert.equal(location.belowMinimumFreeSpace, true);
  assert.equal(location.inspectionError, "volume unavailable");
});

test("invalid filesystem measurements fail closed", () => {
  const [location] = inspectBuildSpace(
    [{ label: "workspace", path: os.tmpdir() }],
    { statfs: () => ({ bsize: 0, bavail: 1 }) },
  );
  assert.equal(location.availableGiB, null);
  assert.equal(location.belowMinimumFreeSpace, true);
});

test("the Windows installer fails closed before installing dependencies", async () => {
  const script = await readFile(new URL("./Start-Windows.ps1", import.meta.url), "utf8");
  const checkAt = script.indexOf("build-space-preflight.mjs");
  const installAt = script.indexOf("Invoke-Pnpm install");
  assert.ok(checkAt >= 0, "Windows build must call the disk preflight");
  assert.ok(installAt > checkAt, "disk preflight must happen before dependency installation");
  assert.match(script, /installer output=/);
  assert.match(script, /temporary files=/);
  assert.match(script, /if \(\$spaceReport\.insufficientSpace\)/);
  assert.match(script, /ARENA_BUILD_MIN_FREE_GIB/);
  assert.match(script, /"--include-pnpm-store" @spaceLocations/);
  assert.ok(script.indexOf("$spaceReport.locations | ForEach-Object") < script.indexOf("$monitorLocationsJson ="));
  assert.doesNotMatch(script, /Read-Host "To continue anyway/);
});

test("command-line preflight blocks low space and allows sufficient space", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-space-cli-"));
  const scriptPath = fileURLToPath(new URL("./build-space-preflight.mjs", import.meta.url));
  try {
    const run = (minimum) => spawnSync(
      process.execPath,
      [scriptPath, `test output=${root}`],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ARENA_BUILD_MIN_FREE_GIB: String(minimum) },
      },
    );
    const lowSpace = run(1_000_000);
    assert.equal(lowSpace.status, 0, lowSpace.stderr);
    assert.equal(JSON.parse(lowSpace.stdout).insufficientSpace, true);

    const sufficientSpace = run(0.000000001);
    assert.equal(sufficientSpace.status, 0, sufficientSpace.stderr);
    assert.equal(JSON.parse(sufficientSpace.stdout).insufficientSpace, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command-line preflight adds headroom from the previous measured build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-space-history-"));
  const scriptPath = fileURLToPath(new URL("./build-space-preflight.mjs", import.meta.url));
  try {
    const generated = path.join(root, "generated-artifacts");
    await mkdir(generated);
    await writeFile(
      path.join(generated, "windows-build-space.json"),
      JSON.stringify({ measuredPeakConsumptionGiB: 28.5 }),
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, `test output=${root}`],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ARENA_BUILD_MIN_FREE_GIB: "20" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.previousPeakConsumptionGiB, 28.5);
    assert.equal(report.minimumFreeGiB, 36);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an absent output directory checks the existing parent without creating it", () => {
  const target = path.join(os.tmpdir(), `arena-output-not-created-${process.pid}`);
  const checked = [];
  const [location] = inspectBuildSpace([{ label: "output", path: target }], {
    statfs: (checkedPath) => {
      checked.push(checkedPath);
      return { bsize: 1, bavail: 30 * GiB };
    },
  });
  assert.notEqual(location.checkedPath, target);
  assert.equal(checked[0], location.checkedPath);
});

test("minimum free space is configurable and uses previous measured peak with headroom", () => {
  assert.equal(parseMinimumFreeGiB(undefined), 20);
  assert.equal(parseMinimumFreeGiB("12.5"), 12.5);
  assert.throws(() => parseMinimumFreeGiB("0"), /positive number/);
  assert.equal(minimumFreeGiBForPreviousBuild(24, 20), 30);
  assert.equal(minimumFreeGiBForPreviousBuild(12, 20), 20);
  assert.equal(minimumFreeGiBForPreviousBuild(null, 20), 20);
});

test("measurement reports phase and peak data without private machine paths", () => {
  const privatePath = "C:\\Users\\Private Name\\Arena";
  const report = summarizeBuildSpaceMeasurement({
    initialLocations: [{
      label: "workspace",
      path: privatePath,
      checkedPath: privatePath,
      availableBytes: 40 * GiB,
      inspectionError: `Could not inspect ${privatePath}`,
    }],
    samples: [
      {
        phase: "chromium-ready",
        checkpoint: true,
        atUtc: "2026-10-31T12:00:00.000Z",
        locations: [{ label: "workspace", freeBytes: 35 * GiB }],
      },
      {
        phase: "staging-ready",
        checkpoint: false,
        locations: [{ label: "workspace", freeBytes: 29 * GiB }],
      },
    ],
    minimumFreeGiB: 20,
    configuredMinimumGiB: 20,
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.measuredPeakConsumptionGiB, 11);
  assert.equal(report.locations[0].peakPhase, "staging-ready");
  assert.equal(report.phases[0].name, "chromium-ready");
  assert.doesNotMatch(serialized, /Private Name|C:\\\\Users|inspectionError|checkedPath/);
});

test("a retry report compares post-cleanup free space with the next build baseline", () => {
  const report = summarizeBuildSpaceMeasurement({
    initialLocations: [{
      label: "workspace",
      availableBytes: 15 * GiB,
    }],
    samples: [{
      phase: "installer-ready",
      checkpoint: false,
      locations: [{ label: "workspace", freeBytes: 7 * GiB }],
    }],
    previousReport: {
      measuredPeakConsumptionGiB: 12,
      phases: [{
        name: "interrupted-build-cleanup-complete",
        freeGiB: [{ label: "workspace", freeGiB: 10 }],
      }],
    },
  });
  assert.equal(report.retryComparison.previousRunPeakConsumptionGiB, 12);
  assert.equal(report.retryComparison.currentRunPeakConsumptionGiB, 8);
  assert.equal(report.retryComparison.peakChangeGiB, -4);
  assert.deepEqual(report.retryComparison.freeSpace, [{
    label: "workspace",
    afterCleanupGiB: 10,
    beforeRetryGiB: 15,
    changeGiB: 5,
  }]);
  assert.equal(report.measuredPeakConsumptionGiB, 8);
});

test("Windows build emits the required disk-space phase checkpoints", async () => {
  const [starter, build, packager] = await Promise.all([
    readFile(new URL("./Start-Windows.ps1", import.meta.url), "utf8"),
    readFile(new URL("./build.mjs", import.meta.url), "utf8"),
    readFile(new URL("./electron-builder.cjs", import.meta.url), "utf8"),
  ]);
  for (const phase of [
    "dependency-installation-start",
    "dependencies-installed",
    "interrupted-build-cleanup-complete",
    "installer-ready",
  ]) assert.ok(starter.includes(phase), `PowerShell runner must record ${phase}`);
  for (const phase of [
    "chromium-ready",
    "postgresql-ready",
    "staging-ready",
    "retry-stage-cleanup-complete",
  ]) assert.ok(build.includes(phase), `build script must record ${phase}`);
  assert.ok(packager.includes("unpacked-output-ready"), "packaging must record unpacked output");
});

test("measurement CLI accepts PowerShell UTF-8 input and writes a sanitized report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-space-report-"));
  const privatePath = path.join(root, "Private Name", "workspace");
  const initialPath = path.join(root, "initial.json");
  const samplesPath = path.join(root, "samples.jsonl");
  const reportPath = path.join(root, "report.json");
  const scriptPath = fileURLToPath(new URL("./build-space-measurement.mjs", import.meta.url));
  try {
    await writeFile(initialPath, `\uFEFF${JSON.stringify([{
      label: "workspace",
      path: privatePath,
      checkedPath: privatePath,
      availableBytes: 4 * GiB,
      inspectionError: `Cannot inspect ${privatePath}`,
    }])}`);
    await writeFile(samplesPath, `${JSON.stringify({
      phase: "postgresql-ready",
      checkpoint: true,
      locations: [{ label: "workspace", freeBytes: 3 * GiB }],
    })}\n`);
    const result = spawnSync(process.execPath, [
      scriptPath,
      initialPath,
      samplesPath,
      reportPath,
      "20",
      "20",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.measuredPeakConsumptionGiB, 1);
    assert.equal(report.phases[0].name, "postgresql-ready");
    assert.doesNotMatch(JSON.stringify(report), /Private Name|inspectionError|checkedPath/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
