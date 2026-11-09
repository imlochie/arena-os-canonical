import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArcadePackages, extractPinnedTar } from "./arcade/packages.mjs";
import { packageDirectory } from "./arcade/directory-package.mjs";
import { downloadPinnedZip, extractSelectedZip } from "./arcade/pinned-zip.mjs";
import { fetchWithTransientRetries } from "./arcade/retry-fetch.mjs";
import { BUILD_TOOLS, selectToolFile } from "./arcade/build-tools.mjs";
import { RepositoryBuilds, repositoryIdentity, sourceBuildIdentity, validateSourceSnapshot, verifyStoppedWorkspace } from "./arcade/repository-builds.mjs";
const JSZip = createRequire(new URL("../artifacts/arenaforge/package.json", import.meta.url))("jszip");
const signal = () => AbortSignal.timeout(30000);
const sha = data => createHash("sha256").update(data).digest("hex");
function snapshot(revision = "a".repeat(40)) {
  const data = Buffer.from("#define SDL_MAIN_HANDLED\n#include <SDL.h>\nint main(){return 0;}");
  return { folder: "", projectType: "sdl", provenance: { repository: "author/game", revision, sourceUrl: `https://github.com/author/game/tree/${revision}`,
    license: { spdx: "MIT", path: "LICENSE", text: "Original MIT test fixture; no real compiler is invoked in these unit tests." } },
    files: [{ path: "main.c", size: data.length, sha: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"), contentBase64: data.toString("base64") }] };
}
test("source pins reject modified bytes, path escapes, duplicate case and unsupported SDL layout", () => {
  const good = snapshot(); assert.equal(validateSourceSnapshot(good), good);
  for (const mutate of [
    source => { source.files[0].contentBase64 = Buffer.from("modified").toString("base64"); },
    source => { source.files[0].path = "../escape.c"; },
    source => { source.files.push({ ...source.files[0], path: "MAIN.c" }); },
    source => { source.files[0].path = "main.cpp"; },
  ]) { const source = structuredClone(good); mutate(source); assert.throws(() => validateSourceSnapshot(source)); }
  assert.equal(repositoryIdentity("Author/Game", ""), repositoryIdentity("author/game", ""));
  assert.notEqual(repositoryIdentity("author/game", ""), repositoryIdentity("author/game", "another/"));
  assert.notEqual(sourceBuildIdentity(good), sourceBuildIdentity(snapshot("b".repeat(40))));
});
test("streamed directory package is deterministic, integrity checked and rejects links before owner-side writes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-build-unit-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "managed", "work", "output"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "game.exe"), Buffer.from("original-unit-fixture"));
  const metadata = { id: "test.game", version: "1", kind: "game", entry: "game.exe", arguments: [], runtimes: [], license: "MIT" };
  const one = await packageDirectory(directory, path.join(root, "one.tar"), metadata, signal());
  const two = await packageDirectory(directory, path.join(root, "two.tar"), metadata, signal());
  assert.equal(one.sha256, two.sha256); assert.equal(sha(await readFile(path.join(root, "one.tar"))), one.sha256);
  const restored = path.join(root, "restored"); await mkdir(restored);
  await extractPinnedTar(path.join(root, "one.tar"), restored, one, signal());
  assert.equal(await readFile(path.join(restored, "game.exe"), "utf8"), "original-unit-fixture");
  if (process.platform !== "win32") {
    await symlink(path.join(root, "outside"), path.join(directory, "malicious-junction"));
    await assert.rejects(verifyStoppedWorkspace(path.join(root, "managed", "work"), path.join(root, "managed")), /link/);
    await assert.rejects(packageDirectory(directory, path.join(root, "bad.tar"), metadata, signal()), /link/);
  }
});
test("ZIP extraction refuses traversal, symbolic links, duplicate case and oversized entries", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-zip-unit-")); t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    zip => zip.file("../escape", "no"),
    zip => zip.file("link", "outside", { unixPermissions: 0o120777 }),
    zip => { zip.file("Game.exe", "one"); zip.file("game.exe", "two"); },
    zip => zip.file("large", Buffer.alloc(100)),
  ];
  for (let i = 0; i < cases.length; i++) {
    const zip = new JSZip(); cases[i](zip);
    const filename = path.join(root, `${i}.zip`);
    await writeFile(filename, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
    await assert.rejects(extractSelectedZip(filename, path.join(root, `out-${i}`), name => name, signal(), { maxBytes: i === 3 ? 10 : 1000 }));
  }
});
test("SDK pins are fixed and selections retain only the intended Windows target", () => {
  for (const pin of Object.values(BUILD_TOOLS)) { assert.match(pin.sha256, /^[a-f0-9]{64}$/); assert.ok(pin.bytes > 0); assert.ok(!pin.url.includes("latest")); }
  assert.equal(selectToolFile("llvm", "llvm/bin/clang.exe"), "bin/clang.exe");
  assert.equal(selectToolFile("llvm", "llvm/aarch64-w64-mingw32/lib/other.a"), null);
  assert.equal(selectToolFile("sdl", "SDL2-2.32.10/i686-w64-mingw32/bin/SDL2.dll"), null);
});
test("ZIP download digest failure and cancellation retain no partial archive", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-pin-unit-")); t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = Buffer.from("unit ZIP transport bytes, not an executable");
  const pin = { url: "https://github.com/author/game/releases/download/v1/game-win64.zip", bytes: bytes.length, sha256: sha(bytes) };
  let fetchCalls = 0;
  globalThis.fetch = async () => ++fetchCalls === 1
    ? new Response("temporary gateway failure", { status: 504 })
    : new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
  const recovered = path.join(root, "recovered.zip");
  await downloadPinnedZip(pin, recovered, signal());
  assert.equal(fetchCalls, 2, "the pinned ZIP downloader recovers from a transient 504");
  assert.deepEqual(await readFile(recovered), bytes);
  globalThis.fetch = async () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
  await assert.rejects(downloadPinnedZip({ ...pin, sha256: "0".repeat(64) }, path.join(root, "bad.zip"), signal()), /digest mismatch/);
  await assert.rejects(readFile(path.join(root, "bad.zip.partial")), { code: "ENOENT" });
  const controller = new AbortController();
  await assert.rejects(downloadPinnedZip(pin, path.join(root, "cancel.zip"), controller.signal, () => controller.abort()), /abort/i);
  await assert.rejects(readFile(path.join(root, "cancel.zip.partial")), { code: "ENOENT" });
});
test("pinned release fetch retries transient HTTP failures but returns permanent failures unchanged", async () => {
  let calls = 0;
  const response = await fetchWithTransientRetries("https://example.invalid/pinned.zip", {}, {
    delayMs: 0,
    fetchImpl: async () => ++calls < 4
      ? new Response("temporary gateway failure", { status: 504 })
      : new Response("pinned bytes", { status: 200 }),
  });
  assert.equal(calls, 4, "bounded retries recover after multiple consecutive gateway failures");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "pinned bytes");

  calls = 0;
  const missing = await fetchWithTransientRetries("https://example.invalid/missing.zip", {}, {
    delayMs: 0,
    fetchImpl: async () => { calls += 1; return new Response("missing", { status: 404 }); },
  });
  assert.equal(calls, 1, "permanent publisher responses are not retried");
  assert.equal(missing.status, 404);
});
test("orchestration unit: updates retain versions, cache reuse skips compilation and rollback/removal preserves profiles", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-repo-unit-")); t.after(() => rm(root, { recursive: true, force: true }));
  const packages = new ArcadePackages({ root: path.join(root, "managed"), catalog: [], reserveBytes: 0 });
  const compilerCalls = [];
  const host = { requirements: () => ({ supportedHost: true }), probe: async () => {}, runningKeys: () => [],
    // Synthetic compiler adapter ONLY. This test is not Windows/build/gameplay evidence.
    execute: async (args, event) => {
      assert.equal(args[0], "run"); assert.equal(args[6], "--"); assert.equal(args.includes("sh"), false);
      compilerCalls.push(args);
      const target = args[args.indexOf("-o") + 1];
      const pe = Buffer.alloc(256); pe.write("MZ"); pe.writeUInt32LE(128, 0x3c); pe.write("PE\0\0", 128); pe.writeUInt16LE(0x8664, 132);
      await writeFile(target, pe); event({ event: "log", text: "synthetic compiler unit adapter" }); return 0;
    } };
  const builds = new RepositoryBuilds({ packages, host }); await builds.initialize(); await packages.initialize();
  const sdk = path.join(root, "sdk"); await mkdir(path.join(sdk, "x86_64-w64-mingw32", "bin"), { recursive: true });
  await writeFile(path.join(sdk, BUILD_TOOLS.sdl.executable), "synthetic DLL");
  builds.tools.ensure = async id => ({ pin: BUILD_TOOLS[id], directory: sdk });
  const first = await builds.build(snapshot(), new AbortController());
  const again = await builds.build(snapshot(), new AbortController()); assert.equal(first, again); assert.equal(compilerCalls.length, 1);
  const second = await builds.build(snapshot("b".repeat(40)), new AbortController());
  const project = builds.state.projects[repositoryIdentity("author/game", "")];
  assert.equal(project.activeKey, second); assert.equal(project.versions.length, 2);
  packages.beforePromote = async () => { throw new Error("simulated interrupted activation"); };
  await assert.rejects(builds.build(snapshot("c".repeat(40)), new AbortController()), /interrupted activation/);
  assert.equal(project.activeKey, second, "failed activation must not switch the active version");
  const compiledBeforeRecovery = compilerCalls.length;
  packages.beforePromote = async () => {};
  const recovered = await builds.build(snapshot("c".repeat(40)), new AbortController());
  assert.equal(compilerCalls.length, compiledBeforeRecovery, "recovery reuses the exact retained output instead of recompiling");
  assert.equal(project.activeKey, recovered);
  const originalExecute = host.execute;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  host.execute = async (_args, _event, _timeout, onChild) => new Promise(resolve => {
    onChild({ stdin: { write: () => resolve(125) }, kill: () => resolve(125) }); entered();
  });
  const cancellation = new AbortController();
  const cancelled = assert.rejects(builds.build(snapshot("d".repeat(40)), cancellation), /abort/i);
  await started; cancellation.abort(); await cancelled;
  assert.equal(project.activeKey, recovered, "cancelling compilation cannot switch the retained current version");
  assert.equal(builds.state.jobs[0].phase, "cancelled");
  host.execute = originalExecute;
  await builds.selectVersion(first); assert.equal(project.activeKey, first);
  const profile = path.join(packages.root, "profiles", project.id); await mkdir(profile); await writeFile(path.join(profile, "save"), "keep");
  await packages.remove(first, []); await builds.removed(first);
  assert.equal(project.activeKey, recovered); assert.equal(await readFile(path.join(profile, "save"), "utf8"), "keep");
  assert.ok(builds.snapshot().jobs.some(job => job.phase === "failed"));
  assert.ok(builds.snapshot().jobs.some(job => job.detail.includes("Recovered")));
  const restoredPackages = new ArcadePackages({ root: packages.root, catalog: [], reserveBytes: 0 });
  const restored = new RepositoryBuilds({ packages: restoredPackages, host }); await restored.initialize(); await restoredPackages.initialize();
  assert.equal(restored.state.projects[project.id].activeKey, recovered);
  await restoredPackages.verify(recovered);
});
