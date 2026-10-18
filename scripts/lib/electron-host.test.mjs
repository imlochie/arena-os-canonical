import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectElectronHost } from "./electron-host.mjs";
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "arena-electron-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "node_modules/electron"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "44.7.0" }));
  writeFileSync(path.join(directory, "index.js"), "throw Error('must never import lazy downloader')");
  return { root, directory };
}
test("missing binary gives actionable diagnostics without importing/downloading Electron", (t) => {
  const { root } = fixture(t);
  const r = inspectElectronHost({ root, env: {}, platform: "linux", probe: () => { throw Error("must not spawn"); } });
  assert.equal(r.readyToLaunch, false); assert.equal(r.binaryVerified, false);
  assert.match(r.issues.join(" "), /desktop:prepare-electron/); assert.match(r.issues.join(" "), /display/);
});
test("present file is not enough: executable version must match", (t) => {
  const { root, directory } = fixture(t); mkdirSync(path.join(directory, "dist"));
  writeFileSync(path.join(directory, "path.txt"), "electron"); writeFileSync(path.join(directory, "dist/electron"), "not a real executable");
  const r = inspectElectronHost({ root, env: { DISPLAY: ":1" }, probe: () => ({ status: 0, stdout: "43.0.0" }) });
  assert.equal(r.readyToLaunch, false); assert.match(r.issues.join(" "), /probe/);
});
test("matching probe is preflight only, and Linux still requires a display", (t) => {
  const { root, directory } = fixture(t); mkdirSync(path.join(directory, "dist"));
  writeFileSync(path.join(directory, "path.txt"), "electron"); writeFileSync(path.join(directory, "dist/electron"), "controlled probe");
  const options = { root, platform: "linux", probe: () => ({ status: 0, stdout: "44.7.0\n" }) };
  assert.equal(inspectElectronHost({ ...options, env: {} }).readyToLaunch, false);
  const r = inspectElectronHost({ ...options, env: { DISPLAY: ":99" } }); assert.equal(r.readyToLaunch, true);
  assert.match(r.evidence, /not Electron UI/);
});
