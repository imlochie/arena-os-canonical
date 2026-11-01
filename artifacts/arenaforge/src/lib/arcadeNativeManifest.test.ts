import assert from "node:assert/strict";
import { test } from "node:test";
import { validArcadeManifest, currentArcadeEvidence } from "./arcadeManifest";
import { nativeWindowsAdapter } from "./arcadeRuntimeAdapters";
test("native projection follows the common contract without claiming startup/gameplay or exporting payloads", async () => {
  const modulePath = new URL("../../../../desktop/arcade/manifest.mjs", import.meta.url).href;
  const { nativeGameManifest } = await import(modulePath);
  const descriptor = { id: "native-test", version: "1", sha256: "a".repeat(64), arguments: ["{profile}"], license: "MIT", source: "PRIVATE PAYLOAD NOT METADATA" };
  const host = { id: "native-session-test", kind: "desktop", platform: "win32", architecture: "x64", capabilities: { "native-lpac-isolation": true } };
  const manifest = nativeGameManifest(descriptor, { phase: "ready", at: 123 }, host);
  assert.ok(validArcadeManifest(manifest));
  assert.ok(currentArcadeEvidence(manifest, host, "installed"));
  assert.equal(currentArcadeEvidence(manifest, host, "startup"), undefined);
  assert.equal(currentArcadeEvidence(manifest, host, "gameplay"), undefined);
  assert.equal(currentArcadeEvidence(manifest, { ...host, id: "another-session" }, "installed"), undefined);
  assert.equal(JSON.stringify(manifest).includes("PRIVATE PAYLOAD"), false);
  assert.equal(nativeWindowsAdapter.diagnostics(manifest, host).available, true); // Declared compatibility only, no OS test.
  assert.equal(nativeWindowsAdapter.diagnostics(manifest, { ...host, kind: "browser", architecture: "browser-managed" }).available, false);
  assert.equal(nativeWindowsAdapter.diagnostics(manifest, { ...host, capabilities: { "native-lpac-isolation": false } }).available, false);
});
