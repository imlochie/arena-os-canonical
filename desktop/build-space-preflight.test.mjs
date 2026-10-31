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
} from "./build-space-preflight.mjs";

const GiB = 1024 ** 3;

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
