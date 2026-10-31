import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BUILD_SPACE_WARNING_GIB, inspectBuildSpace } from "./build-space-preflight.mjs";

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
  assert.deepEqual(checked, ["C:\\Arena", "D:\\Temp"]);
  assert.deepEqual(locations.map(({ label, availableGiB, belowWarningThreshold }) => ({
    label,
    availableGiB,
    belowWarningThreshold,
  })), [
    { label: "workspace", availableGiB: 30, belowWarningThreshold: false },
    { label: "temporary files", availableGiB: 30, belowWarningThreshold: false },
  ]);
});

test("marks low-space locations for an explicit confirmation", () => {
  const [location] = inspectBuildSpace(
    [{ label: "workspace", path: "C:\\Arena" }],
    { statfs: () => ({ bsize: 1, bavail: 8 * GiB }), warningThresholdGiB: 20 },
  );
  assert.equal(location.belowWarningThreshold, true);
  assert.equal(BUILD_SPACE_WARNING_GIB, 20);
});

test("uses total free blocks when unprivileged free blocks are unavailable", () => {
  const [location] = inspectBuildSpace(
    [{ label: "workspace", path: "C:\\Arena" }],
    { statfs: () => ({ bsize: 1, bfree: 24 * GiB }) },
  );
  assert.equal(location.availableGiB, 24);
  assert.equal(location.belowWarningThreshold, false);
});

test("an unreadable build location requires confirmation instead of passing silently", () => {
  const [location] = inspectBuildSpace(
    [{ label: "user caches", path: "C:\\Users\\Owner\\AppData\\Local" }],
    { statfs: () => { throw new Error("volume unavailable"); } },
  );
  assert.equal(location.availableGiB, null);
  assert.equal(location.belowWarningThreshold, true);
  assert.equal(location.inspectionError, "volume unavailable");
});

test("the Windows installer checks free space before installing dependencies", async () => {
  const script = await readFile(new URL("./Start-Windows.ps1", import.meta.url), "utf8");
  const checkAt = script.indexOf("build-space-preflight.mjs");
  const installAt = script.indexOf("Invoke-Pnpm install");
  assert.ok(checkAt >= 0, "Windows build must call the disk preflight");
  assert.ok(installAt > checkAt, "disk preflight must happen before dependency installation");
  assert.match(script, /belowWarningThreshold/);
  assert.match(script, /-cne "CONTINUE"/);
});
