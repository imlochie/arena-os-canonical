import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { stageBepInExDistribution } from "./arcade/bepinex-distribution.mjs";

test("untrusted loader archives never create a prepared installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-loader-deny-"));
  try {
    const archive = path.join(root, "bad.zip"); await writeFile(archive, "not an upstream distribution");
    await assert.rejects(stageBepInExDistribution({ archive, destination: path.join(root, "loader"), host: "windows-x64" }), /file\/size/);
    await assert.rejects(stageBepInExDistribution({ archive, destination: path.join(root, "loader"), host: "linux-arm64" }), /No pinned/);
    await mkdir(path.join(root, "existing"));
    await writeFile(path.join(root, "existing", "retain"), "keep");
    await assert.rejects(stageBepInExDistribution({ archive, destination: path.join(root, "existing"), host: "windows-x64" }), /already exists/);
    assert.equal(await readFile(path.join(root, "existing", "retain"), "utf8"), "keep");
    if (process.platform !== "win32") {
      await symlink(root, path.join(root, "link"));
      await assert.rejects(stageBepInExDistribution({ archive, destination: path.join(root, "link", "loader"), host: "windows-x64" }), /ordinary/);
    }
    assert.ok(!(await readdir(root)).some(name => name.startsWith(".loader-stage")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [host, name] of [["windows-x64", "windows.zip"], ["linux-x64", "linux.zip"]]) {
  const archive = fileURLToPath(new URL(`../generated-artifacts/bepinex-research/${name}`, import.meta.url));
  let present = true; try { await access(archive); } catch { present = false; }
  test(`actual pinned ${host} upstream archive stages without execution`, { skip: !present }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-loader-real-"));
    try {
      const destination = path.join(root, "prepared");
      const result = await stageBepInExDistribution({ archive, destination, host });
      assert.equal(result.status, "prepared-unverified");
      assert.equal(result.gameplayVerified, false);
      assert.ok(result.files.some(file => file.path === "BepInEx/core/BepInEx.Preloader.dll"));
      assert.ok(!(await readdir(root)).some(name => name.startsWith(".loader-stage")));
      assert.ok(!(await readdir(destination)).includes(".archive.zip"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
