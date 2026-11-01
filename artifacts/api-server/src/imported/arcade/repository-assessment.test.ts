import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assessGithubRepository, assessRepository, recallRepositoryAssessment, rememberRepositoryAssessment } from "./repository-assessment";
import { RepositoryImportError } from "./repository-source";

const revision = "a".repeat(40);
const signal = () => AbortSignal.timeout(10000);
const blob = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function fixture(source: Record<string, string>, spdx = "MIT", releases: unknown[] = []) {
  const bytes = new Map(Object.entries({ LICENSE: "MIT fixture license", ...source }).map(([name, text]) => [name, Buffer.from(text)]));
  const nodes = [...bytes].map(([path, data]) => ({ path, type: "blob", mode: "100644", sha: blob(data), size: data.length }));
  const calls: string[] = [];
  const read = async (url: string, limit: number) => {
    calls.push(url);
    const u = new URL(url);
    const suffix = u.pathname.replace("/repos/author/game", "");
    let result: Buffer;
    if (u.hostname === "raw.githubusercontent.com") result = bytes.get(decodeURIComponent(u.pathname.slice(`/author/game/${revision}/`.length)))!;
    else if (!suffix) result = Buffer.from(JSON.stringify({ private: false, default_branch: "main" }));
    else if (suffix.startsWith("/commits/")) result = Buffer.from(JSON.stringify({ sha: revision }));
    else if (suffix.startsWith("/git/ref/tags/")) result = Buffer.from(JSON.stringify({ object: { type: "commit", sha: revision } }));
    else if (suffix.startsWith("/git/trees/")) result = Buffer.from(JSON.stringify({ truncated: false, tree: nodes }));
    else if (suffix === "/license") result = Buffer.from(JSON.stringify({ path: "LICENSE", encoding: "base64", content: bytes.get("LICENSE")!.toString("base64"), license: { spdx_id: spdx } }));
    else if (suffix === "/releases") result = Buffer.from(JSON.stringify(releases));
    else throw new Error(`Unexpected fixture URL ${url}`);
    assert.ok(result && result.length <= limit);
    return result;
  };
  return { read, nodes, bytes, calls };
}
test("Godot review verifies project/main scene and source license without executing a build", async () => {
  const f = fixture({ "project.godot": 'config_version=5\nrun/main_scene="res://main.tscn"\n', "main.tscn": "[gd_scene format=3]", "main.gd": "extends Node" });
  const review = await assessGithubRepository("https://github.com/author/game", signal(), f.read);
  assert.equal(review.projectType, "godot"); assert.equal(review.confidence, "high");
  assert.equal(review.revision, revision); assert.equal(review.reference, "main");
  assert.equal(review.license?.spdx, "MIT"); assert.deepEqual(review.blockers, []);
  assert.deepEqual(review.modHooks, []);
  assert.ok(review.evidence.some(row => row.path === "main.tscn"));
});
test("large native projects can review pinned releases without pretending full source was acquired", async () => {
  const f = fixture({ "CMakeLists.txt": "project(ActualGame LANGUAGES CXX)" });
  const reader: ReadBytes = (url, limit, signal) => url.includes("?recursive=1")
    ? Promise.resolve(Buffer.from(JSON.stringify({ truncated: true, tree: [] }))) : f.read(url, limit, signal);
  const review = await assessGithubRepository("https://github.com/author/game", signal(), reader);
  assert.equal(review.projectType, "native");
  assert.ok(review.blockers.some(blocker => blocker.includes("Only root metadata")));
  assert.ok(review.blockers.some(blocker => blocker.includes("no approved source build")));
  assert.equal(review.license?.spdx, "MIT");
  assert.ok(review.evidence.some(row => row.detail.includes("not the full repository")));
});
test("SDL event/render evidence is distinguished from a supported compiler layout", async () => {
  for (const extension of ["c", "cpp"]) {
    const f = fixture({ [`main.${extension}`]: "#include <SDL.h>\nvoid play(){SDL_PollEvent(0);SDL_RenderPresent(0);}",
      "CMakeLists.txt": 'find_package(SDL2 REQUIRED)\nexecute_process(COMMAND do-not-run-this)',
      "package.json": '{"scripts":{"postinstall":"do-not-run-this"}}' });
    const review = await assessGithubRepository("https://github.com/author/game", signal(), f.read);
    assert.equal(review.projectType, "sdl"); assert.equal(review.confidence, "high");
    assert.equal(review.blockers.length, extension === "c" ? 0 : 1);
    assert.ok(review.buildSystems.some(row => row.includes("not executed")));
    assert.ok(review.dependencies.some(row => row.includes("offline")));
  }
});
test("missing license and non-game source remain reviewable, not installable", async () => {
  const f = fixture({ "README.md": "The greatest game ever", "library.py": "pass" }, "NOASSERTION");
  const review = await assessGithubRepository("https://github.com/author/game", signal(), f.read);
  assert.equal(review.projectType, "unknown"); assert.equal(review.license, null);
  assert.ok(review.blockers.some(row => row.includes("license"))); assert.ok(review.blockers.some(row => row.includes("game entry")));
});
test("modified pinned source, submodules and native extensions do not become ready builds", async () => {
  const changed = fixture({ "project.godot": 'config_version=5\nrun/main_scene="res://main.tscn"', "main.tscn": "scene" });
  changed.bytes.set("project.godot", Buffer.from("tampered"));
  await assert.rejects(assessGithubRepository("https://github.com/author/game", signal(), changed.read), /Pinned file verification/);
  const linked = fixture({ "project.godot": 'config_version=5\nrun/main_scene="res://main.tscn"', "main.tscn": "scene", "native.gdextension": "plugin" });
  linked.nodes.push({ path: "external", type: "commit", mode: "160000", sha: revision, size: 0 });
  const review = await assessGithubRepository("https://github.com/author/game", signal(), linked.read);
  assert.ok(review.blockers.some(row => row.includes("submodule"))); assert.ok(review.blockers.some(row => row.includes("native extensions")));
});
test("release digests are evidence, absent digests stay absent and links cannot escape the repository", async () => {
  const assets = ["game-win64.zip", "old-win64.zip", "escape.zip"].map((name, i) => ({
    name, size: 1000, browser_download_url: i === 2 ? "https://example.org/escape.zip" : `https://github.com/author/game/releases/download/v1/${name}`,
    digest: i ? null : `sha256:${"b".repeat(64)}`,
  }));
  const f = fixture({ "main.c": "#include <SDL.h>" }, "MIT", [{ tag_name: "v1", name: "Release 1", assets }]);
  const review = await assessGithubRepository("https://github.com/author/game/releases/tag/v1", signal(), f.read);
  assert.equal(review.reference, "v1"); assert.equal(review.releases[0].assets.length, 2);
  assert.equal(review.releases[0].assets[0].sha256, "b".repeat(64)); assert.equal(review.releases[0].assets[1].sha256, null);
  assert.ok(f.calls.some(url => url.includes("/git/ref/tags/v1")), "tag pin does not accidentally resolve a same-named branch");
});
test("reviews are owner-bound, replaced on re-review and expire", async () => {
  const f = fixture({ "index.html": "<canvas></canvas>" });
  const review = await assessGithubRepository("https://github.com/author/game", signal(), f.read);
  const first = rememberRepositoryAssessment("one", review);
  assert.throws(() => recallRepositoryAssessment("two", first.token), /another owner/);
  const second = rememberRepositoryAssessment("one", review);
  assert.throws(() => recallRepositoryAssessment("one", first.token), /expired/);
  assert.equal(recallRepositoryAssessment("one", second.token), review);
  const now = Date.now;
  try { Date.now = () => second.expiresAt + 1; assert.throws(() => recallRepositoryAssessment("one", second.token), /expired/); }
  finally { Date.now = now; }
});
test("unregistered repository providers are refused before network access", async () => {
  await assert.rejects(assessRepository("https://example.org/author/game", signal()), error => error instanceof RepositoryImportError && error.status === 400);
});
