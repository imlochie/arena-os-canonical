import test from "node:test";
import assert from "node:assert/strict";
import { assessUnityMonoLayout, BEPINEX_RELEASES, identifyExecutable } from "./arcade/bepinex.mjs";

function pe(machine = 0x8664) {
  const b = Buffer.alloc(256); b.write("MZ"); b.writeUInt32LE(128, 60);
  b.write("PE\0\0", 128); b.writeUInt16LE(machine, 132); return b;
}
function layout() {
  return { host: "windows-x64", entry: "Game.exe", header: pe(), files: [
    "Game.exe", "Game_Data/globalgamemanagers", "Game_Data/Managed/Assembly-CSharp.dll",
    "MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll",
  ] };
}

test("matching Mono layout is a candidate, never installation/gameplay proof", () => {
  const r = assessUnityMonoLayout(layout());
  assert.equal(r.candidate, true);
  assert.equal(r.canInstall, false);
  assert.equal(r.gameplayVerified, false);
  assert.equal(r.distribution, BEPINEX_RELEASES["windows-x64"]);
  assert.ok(r.installationBlockers.length);
});
test("IL2CPP and mixed layouts are rejected", () => {
  for (const marker of ["GameAssembly.dll", "Game_Data/il2cpp_data/Metadata/global-metadata.dat"]) {
    const input = layout(); input.files.push(marker);
    assert.match(assessUnityMonoLayout(input).blockers.join(" "), /IL2CPP/);
  }
});
test("game executable headers, not names, decide architecture", () => {
  for (const header of [pe(0x14c), pe(0xaa64), Buffer.from("not a PE executable")]) {
    assert.equal(assessUnityMonoLayout({ ...layout(), header }).candidate, false);
  }
  const corrupt = pe(); corrupt.writeUInt32LE(0xffffffff, 60);
  assert.equal(identifyExecutable(corrupt), null);
});
test("an unrelated Unity game cannot lend its Mono layout", () => {
  const input = layout(); input.entry = "Other.exe"; input.files.push("Other.exe");
  assert.equal(assessUnityMonoLayout(input).candidate, false);
});
test("loader collisions, unsafe paths and missing runtime fail before modification", () => {
  for (const marker of ["winhttp.dll", "BepInEx/plugins/Existing.dll", "../escape.dll", "game.exe"]) {
    const input = layout(); input.files.push(marker);
    assert.equal(assessUnityMonoLayout(input).candidate, false);
  }
  const input = layout(); input.files.pop();
  assert.match(assessUnityMonoLayout(input).blockers.join(" "), /Mono runtime/);
});
test("Linux Mono preflight does not require Wine", () => {
  const header = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(header); header.writeUInt16LE(62, 18);
  const r = assessUnityMonoLayout({
    host: "linux-x64", entry: "Game.x86_64", header,
    files: ["Game.x86_64", "Game_Data/globalgamemanagers", "Game_Data/Managed/Assembly-CSharp.dll",
      "MonoBleedingEdge/EmbedRuntime/libmonobdwgc-2.0.so"],
  });
  assert.equal(r.candidate, true);
  assert.equal(r.canInstall, false);
});
