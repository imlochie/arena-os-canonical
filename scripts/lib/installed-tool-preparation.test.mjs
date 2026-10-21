import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareInstalledNativeTools } from "./installed-tool-preparation.mjs";

test("offline preparation repairs already-installed packages even when tsc exists; repeatable without installers", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-offline-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pg = path.join(root, "node_modules/@embedded-postgres/linux-x64");
  mkdirSync(path.join(pg, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/.bin/tsc"), "already present");
  writeFileSync(path.join(pg, "scripts/hydrate-symlinks.js"), "require('node:fs').writeFileSync('hydrated','yes')");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const dir = path.join(root, `node_modules/@${tool}-installer/linux-x64`); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, tool), "installed fixture", { mode: 0o640 });
  }
  for (let i = 0; i < 2; i++) {
    assert.equal(prepareInstalledNativeTools(root, { platform: "linux", arch: "x64" }).length, 3);
    assert.ok(existsSync(path.join(pg, "hydrated")));
    assert.equal(statSync(path.join(root, "node_modules/@ffprobe-installer/linux-x64/ffprobe")).mode & 0o777, 0o740);
  }
});
test("missing packages are not installed or invented", () => {
  assert.deepEqual(prepareInstalledNativeTools("/does-not-exist", { platform: "win32", arch: "x64" }), []);
});
