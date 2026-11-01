import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { acquireModRepository } from "./mod-repository";
import { modHash, parseModPackage } from "@workspace/arena/lib/mod-workshop";
test("repository intake pins the package and license bytes without running hooks", async () => {
  const revision = "a".repeat(40), original = await modHash("original"), payload = Buffer.from("green"), license = Buffer.from("MIT: permission granted. Original test fixture.");
  const manifest = {
    schema: "arena.arcade.mod", schemaVersion: 1, id: "repository-test", name: "Repository fixture", version: "1.0.0",
    source: { kind: "local" }, license: { spdx: "MIT", text: license.toString(), redistributable: true }, base: { id: "fixture", version: `sha256:${original}`, files: { "asset.txt": original } },
    adapter: "files", permissions: ["assets"], requires: [], after: [], conflicts: [], settings: {}, operations: [{ kind: "replace", target: "asset.txt", payload: "asset.txt", baseSha256: original, resultSha256: await modHash(payload) }], payloads: { "asset.txt": await modHash(payload) },
  };
  const content = Buffer.from(JSON.stringify({ manifest, files: { "asset.txt": payload.toString("base64") } }));
  const git = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  let corrupt = false;
  const read = async (url: string) => {
    if (url.includes("raw.githubusercontent.com")) return corrupt ? Buffer.from("corrupt package") : content;
    if (url.endsWith("/commits/main")) return Buffer.from(JSON.stringify({ sha: revision }));
    if (url.includes("/git/trees/")) return Buffer.from(JSON.stringify({ tree: [{ path: "LICENSE", type: "blob", mode: "100644", size: license.length, sha: git(license) }, { path: "arcade-mod.json", type: "blob", mode: "100644", size: content.length, sha: git(content) }] }));
    if (url.includes("/license?")) return Buffer.from(JSON.stringify({ path: "LICENSE", encoding: "base64", content: license.toString("base64"), license: { spdx_id: "MIT" } }));
    return Buffer.from(JSON.stringify({ private: false, disabled: false, default_branch: "main" }));
  };
  const result = await acquireModRepository("https://github.com/fixture/mod", new AbortController().signal, read);
  const mod = await parseModPackage(result.packageJson);
  assert.equal(mod.manifest.source.revision, revision);
  assert.equal(mod.manifest.source.url, `https://github.com/fixture/mod/tree/${revision}`);
  assert.match(mod.manifest.license.text, /Verified repository license/);
  corrupt = true; await assert.rejects(acquireModRepository("https://github.com/fixture/mod", new AbortController().signal, read), /verification failed/);
});
