import test from "node:test";
import assert from "node:assert/strict";
import { assessCompatibilityHost } from "./arcade/compatibility.mjs";

test("Windows x64 recommends native releases, never unnecessary Wine/Proton setup", () => {
  const result = assessCompatibilityHost({ platform: "win32", arch: "x64" });
  assert.equal(result.nativeWindows.candidate, true);
  assert.match(result.nativeWindows.reason, /native release/);
  assert.match(result.nativeWindows.reason, /LPAC/);
  assert.equal(result.wine.available, false);
  assert.equal(result.proton.available, false);
  assert.equal(result.gameplayVerified, false);
});

test("unsupported Windows architectures do not become Wine-supported", () => {
  for (const arch of ["arm64", "ia32"]) {
    const result = assessCompatibilityHost({ platform: "win32", arch });
    assert.equal(result.nativeWindows.candidate, false);
    assert.equal(result.wine.available, false);
    assert.match(result.nativeWindows.reason, new RegExp(arch));
  }
});

test("Linux facilities and installed commands cannot promote an absent execution service", () => {
  const facilities = { graphics: { x11Connected: true }, audio: { pulseConnected: true },
    containment: { namespacePrimitivePassed: true }, tools: { wine: true, steam: true } };
  const result = assessCompatibilityHost({ platform: "linux", arch: "x64", facilities });
  assert.deepEqual(result.facilities, facilities);
  assert.equal(result.wine.available, false);
  assert.match(result.wine.reasons.join(" "), /No Linux.*driver is registered/);
  assert.match(result.proton.reasons.join(" "), /standalone runner/);
  assert.equal(result.gameplayVerified, false);
});

test("hosted server OS must not be mistaken for the owner's local desktop", () => {
  for (const platform of ["win32", "linux"]) {
    const result = assessCompatibilityHost({ platform, arch: "x64", context: "hosted" });
    assert.equal(result.nativeWindows.candidate, false);
    assert.equal(result.wine.available, false);
    assert.match(result.scope, /not the user's laptop/);
    assert.match(result.nativeWindows.reason, /does not provide/);
  }
});

test("macOS and ARM Linux have no implicit compatibility or architecture fallback", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "arm64"]]) {
    const result = assessCompatibilityHost({ platform, arch });
    assert.equal(result.nativeWindows.candidate, false);
    assert.equal(result.wine.available, false);
    assert.match(result.wine.reasons.join(" "), /arm64/);
    assert.equal(result.proton.available, false);
  }
});
