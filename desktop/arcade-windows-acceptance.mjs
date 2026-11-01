import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ArcadePackages, packageKey } from "./arcade/packages.mjs";
import { NativeArcadeHost } from "./arcade/host.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageDirectory = path.join(root, "generated-artifacts/arcade-native-packages");
const reportDirectory = path.join(root, "generated-artifacts/arcade-windows-acceptance");
const helper = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "stage/native/arena-native-host.exe");
const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, osRelease: os.release(), simulated: false, status: "incomplete", stages: {} };
let temporary, host;
async function waitUntil(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for the real native process.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function nativeKeyboard(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  // Test-only OS input, not an IPC bypass or a production approval flag.
  const source = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ArenaFixtureInput {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string t);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,UIntPtr w,IntPtr l);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
 $h = [ArenaFixtureInput]::FindWindow($null,'Arena SDL fixture - arrows move; close to save')
 [uint32]$owner = 0
 if ($h -ne [IntPtr]::Zero) { [void][ArenaFixtureInput]::GetWindowThreadProcessId($h,[ref]$owner) }
 if ($owner -eq ${pid} -and [ArenaFixtureInput]::IsWindowVisible($h)) { break }
 Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
if ($owner -ne ${pid} -or -not [ArenaFixtureInput]::IsWindowVisible($h)) { throw 'No visible SDL window owned by the expected isolated process.' }
[void][ArenaFixtureInput]::SetForegroundWindow($h)
if (-not [ArenaFixtureInput]::PostMessage($h,0x100,[UIntPtr]39,[IntPtr]0x014d0001)) { throw 'OS key-down was refused.' }
if (-not [ArenaFixtureInput]::PostMessage($h,0x101,[UIntPtr]39,[IntPtr]0xc14d0001L)) { throw 'OS key-up was refused.' }
`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';${source}`, "utf16le").toString("base64")], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let errors = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("OS keyboard fixture driver timed out.")); }, 10000);
    child.stderr.on("data", bytes => { errors += bytes.toString().slice(0, 8192 - errors.length); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`OS keyboard driver failed: ${errors}`)); });
  });
}
try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Real Windows x64 is required. A skipped or simulated run is not a pass.");
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "arcade-catalog.json"), "utf8"));
  const catalog = manifest.packages.map(item => item.kind === "game" ? { ...item, arguments: [...item.arguments, "--acceptance"] } : item);
  temporary = await mkdtemp(path.join(os.tmpdir(), "arena-lpac-acceptance-"));
  const packages = new ArcadePackages({ root: temporary, catalog });
  await packages.initialize();
  host = new NativeArcadeHost({ packages, helper });
  await host.initialize(); await host.probe();
  report.stages.containment = host.proof;
  for (const item of catalog) {
    await packages.install(packageKey(item), path.join(packageDirectory, `${packageKey(item)}.tar`));
    await packages.verify(packageKey(item));
  }
  report.stages.pinnedInstall = true;
  const game = catalog.find(item => item.kind === "game"); assert.ok(game);
  const key = packageKey(game);
  report.game = { key, archiveSha256: game.sha256, sourceFiles: game.files };
  report.stages.sessions = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { id } = await host.launch(key);
    const run = host.runs.get(id);
    await waitUntil(() => run.nativePid || !run.child);
    await nativeKeyboard(run.nativePid);
    await run.exited;
    assert.equal(run.phase, "exited", run.logs.join("\n"));
    const line = run.logs.join("\n").match(/\{"fixture":"arena-sdl-v1"[^\n]*\}/)?.[0];
    assert.ok(line, "The pinned fixture did not report render/input/audio/save evidence.");
    const result = JSON.parse(line);
    assert.equal(result.savedBefore, attempt); assert.equal(result.savedAfter, attempt + 1);
    assert.equal(result.renderReadback, true); assert.equal(result.input, "Win32 keyboard event");
    assert.ok(result.audioCallbacks > 1024);
    if (attempt) assert.equal(result.xBefore, report.stages.sessions[0].xAfter, "Visible rectangle position must restore, not just a hidden save counter.");
    assert.equal(Number(await readFile(path.join(run.profile, "fixture-score.txt"), "utf8")), attempt + 1);
    report.stages.sessions.push(result);
  }
  // A third launch verifies explicit stop, without weakening production policy.
  const { id } = await host.launch(key);
  const run = host.runs.get(id); await waitUntil(() => run.nativePid || !run.child);
  await host.stop(id); assert.equal(run.phase, "stopped", run.logs.join("\n"));
  report.stages.explicitStop = true;
  await assert.rejects(packages.remove(game.runtimes[0]), /references/);
  const retainedProfile = run.profile;
  await packages.remove(key); await packages.remove(game.runtimes[0]);
  assert.equal(Number(await readFile(path.join(retainedProfile, "fixture-score.txt"), "utf8")), 2);
  report.stages.removalRetainsSaves = true;
  report.audioEvidence = "A real SDL output device opened and requested nonzero PCM callbacks. Acoustic audibility was not measured; no dummy audio driver is injected.";
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.message;
  report.runs = host?.snapshot().runs;
  process.exitCode = 1;
} finally {
  await host?.shutdown().catch(error => { report.shutdownError = error.message; report.status = "failed"; process.exitCode = 1; });
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, "report.json"), JSON.stringify(report, null, 2));
  if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ status: report.status, report: "generated-artifacts/arcade-windows-acceptance/report.json", error: report.error }));
}
