import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { assertArcadeSender } from "./arcade/control.mjs";
import { NativeArcadeHost } from "./arcade/host.mjs";
import { ArcadePackages, packageKey } from "./arcade/packages.mjs";
import { buildPinnedPackage } from "./arcade/tar-build.mjs";
const origin = "http://127.0.0.1:1777";
test("native owner gate rejects other windows, subframes, hosted origins and shell/path-shaped requests", () => {
  const frame = { url: `${origin}/arcade` }, contents = { mainFrame: frame }, window = { webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertArcadeSender(event, window, origin, { action: "inspect" }));
  assert.throws(() => assertArcadeSender({ ...event, sender: {} }, window, origin, { action: "inspect" }));
  assert.throws(() => assertArcadeSender({ ...event, senderFrame: { ...frame } }, window, origin, { action: "inspect" }));
  frame.url = "https://hosted-preview.example/arcade";
  assert.throws(() => assertArcadeSender(event, window, origin, { action: "inspect" }));
  frame.url = `${origin}/arcade`;
  for (const request of [{ action: "command.run", key: "cmd.exe" }, { action: "launch", key: "a\nb" }, { action: "install", key: "game", source: "C:/secret" }])
    assert.throws(() => assertArcadeSender(event, window, origin, request));
});
async function temporary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-native-controls-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("unsupported hosts never spawn native helpers or treat a known package as executable", () => temporary(async root => {
  const packages = new ArcadePackages({ root, catalog: [] }); await packages.initialize();
  const host = new NativeArcadeHost({ packages, helper: "/not-used", platform: "linux", arch: "x64", spawnProcess: () => { throw new Error("Must not spawn"); } });
  assert.equal((await host.probe()).verified, false);
  await assert.rejects(host.launch("unknown"), /Windows/);
  await assert.rejects(host.stop("1234"), /not owned/);
  assert.deepEqual(Object.keys(host.environment()).filter(key => /SECRET|DATABASE|TOKEN|API_KEY/.test(key)), []);
}));
test("unit protocol simulations cannot upgrade process-started or game-printed JSON into a containment proof", () => temporary(async root => {
  const helper = path.join(root, "dummy-helper"); await writeFile(helper, "This test does not execute a Windows helper.");
  const packages = new ArcadePackages({ root, catalog: [] }); await packages.initialize();
  for (const output of [
    { event: "isolated", backend: "windows-lpac-job-v1", pid: 42 },
    { event: "log", text: JSON.stringify({ event: "probe", passed: true, filesystem: true }) },
    { event: "probe", backend: "windows-lpac-job-v1", passed: true, filesystem: true },
  ]) {
    const host = new NativeArcadeHost({ packages, helper, platform: "win32", arch: "x64",
      spawnProcess: () => spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(output))})`], { stdio: ["pipe", "pipe", "pipe"] }) });
    await assert.rejects(host.probe(), /could not be verified/);
    assert.equal(host.requirements().verified, false);
  }
}));
test("supervisor spawn failures reject without crashing the owning process", () => temporary(async root => {
  const packages = new ArcadePackages({ root, catalog: [] }); await packages.initialize();
  const host = new NativeArcadeHost({ packages, helper: path.join(root, "missing-executable") });
  await assert.rejects(host.execute([], () => {}), /ENOENT/);
}));
test("unit simulated supervisor supports owned stop and reports failed stops as crashes, never gameplay proof", () => temporary(async root => {
  const fixture = buildPinnedPackage({ id: "control-fixture", version: "1.0.0", kind: "game", entry: "fixture.exe",
    license: "MIT, synthetic storage-only fixture", files: [{ path: "fixture.exe", data: "Not an executable; real native execution is not tested here." }] });
  const packages = new ArcadePackages({ root, catalog: [fixture.descriptor], reserveBytes: 0 }); await packages.initialize();
  const archive = path.join(root, "fixture.tar"); await writeFile(archive, fixture.archive);
  await packages.install(packageKey(fixture.descriptor), archive);
  for (const exitCode of [0, 1]) {
    const host = new NativeArcadeHost({ packages, helper: "/simulated", platform: "win32", arch: "x64",
      spawnProcess: () => spawn(process.execPath, ["-e", `console.log(JSON.stringify({event:'isolated',pid:process.pid})); process.stdin.once('data',()=>process.exit(${exitCode}));`], { stdio: ["pipe", "pipe", "pipe"] }) });
    // Internal test fixture only, not an app configuration/renderer bypass.
    host.proof = { checkedAt: Date.now(), simulated: true };
    const { id } = await host.launch(packageKey(fixture.descriptor));
    assert.deepEqual(host.runningKeys(), [packageKey(fixture.descriptor)]);
    await host.stop(id);
    assert.equal(host.runs.get(id).phase, exitCode === 0 ? "stopped" : "crashed");
    assert.equal(host.runs.get(id).gameplayVerified, false);
    assert.deepEqual(host.runningKeys(), []);
  }
}));
