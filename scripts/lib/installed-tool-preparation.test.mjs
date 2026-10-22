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
    const probe = path.join(root, "node_modules/@ffprobe-installer/linux-x64/ffprobe");
    if (process.platform === "win32") {
      // Windows has no POSIX mode bits: chmod only toggles the read-only
      // attribute, so asserting 0o740 there would test the OS, not the code.
      // Keep the meaningful part of the contract — the binary still exists,
      // is readable, and was not emptied by the chmod — and state the gap.
      assert.equal(statSync(probe).size, "installed fixture".length, "chmod must not truncate the binary");
      assert.ok((statSync(probe).mode & 0o400) !== 0, "binary must stay readable after the executable-bit pass");
    } else {
      assert.equal(statSync(probe).mode & 0o777, 0o740);
    }
  }
});
test("missing packages are not installed or invented", () => {
  assert.deepEqual(prepareInstalledNativeTools("/does-not-exist", { platform: "win32", arch: "x64" }), []);
});
