import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeModWorkshop } from "./arcade/workshop.mjs";
import { modHash } from "../lib/arena/src/lib/games/mod-workshop";
test("native profiles stage verified overlays, preserve the base, isolate saves, reject tampering and roll back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arena-workshop-"));
  try {
    const install = path.join(root, "installed"); await mkdir(install);
    await writeFile(path.join(install, "game.exe"), "ORIGINAL AUTHORIZED TEST MARKER, NOT AN EXECUTABLE");
    await writeFile(path.join(install, "asset.txt"), "original");
    const digest = await modHash("original");
    const descriptor = { id: "authorized-fixture", version: "1", kind: "game", title: "Authorized test fixture", sha256: "a".repeat(64), unpackedBytes: 128,
      files: [{ path: "game.exe", bytes: 53, sha256: await modHash(await readFile(path.join(install, "game.exe"))) }, { path: "asset.txt", bytes: 8, sha256: digest }] };
    const key = "authorized-fixture@1", launches: any[] = [];
    const packages = { root, reserveBytes: 0, catalog: new Map([[key, descriptor]]), state: { packages: { [key]: { phase: "ready" } } }, filename: () => install, verify: async () => descriptor };
    const host = { runs: new Map(), launch: async (key: string, context: unknown) => { launches.push({ key, context }); return { phase: "starting", gameplayVerified: false }; } };
    const workshop = new NativeModWorkshop(packages, host); await workshop.initialize();
    let state = await workshop.engine.create(key, "Modded", false, 0); const id = state.profiles[0].id;
    const output = Buffer.from("MODDED");
    const json = JSON.stringify({ manifest: {
      schema: "arena.arcade.mod", schemaVersion: 1, id: "asset-change", version: "1.0.0", name: "Asset fixture",
      license: { spdx: "MIT", text: "Original test fixture; permission to modify and redistribute.", redistributable: true }, source: { kind: "local" },
      base: { id: descriptor.id, version: `sha256:${descriptor.sha256}`, files: { "asset.txt": digest } }, adapter: "files", permissions: ["assets"], requires: [], conflicts: [], after: [], settings: {},
      operations: [{ kind: "replace", target: "asset.txt", payload: "asset.txt", baseSha256: digest, resultSha256: await modHash(output) }], payloads: { "asset.txt": await modHash(output) },
    }, files: { "asset.txt": output.toString("base64") } });
    const review = await workshop.engine.review(key, id, { packageJson: json }, 1); state = await workshop.engine.commit(review.id);
    state = await workshop.engine.activate(key, id, state.revision);
    await workshop.launch(key, id); const context = launches[0].context;
    assert.equal(await readFile(path.join(context.install, "asset.txt"), "utf8"), "MODDED");
    assert.equal(await readFile(path.join(install, "asset.txt"), "utf8"), "original");
    assert.equal(context.dataProfile, `mod-${id}`);
    const before = await workshop.engine.inspect(key);
    const remove = await workshop.engine.review(key, id, { remove: "asset-change@1.0.0" }, before.revision);
    state = await workshop.engine.commit(remove.id); await workshop.launch(key, id);
    assert.equal(await readFile(path.join(launches.at(-1).context.install, "asset.txt"), "utf8"), "original");
    state = await workshop.engine.rollback(key, id, state.revision); await workshop.launch(key, id);
    const modInstall = launches.at(-1).context.install;
    assert.equal(await readFile(path.join(modInstall, "asset.txt"), "utf8"), "MODDED");
    await writeFile(path.join(modInstall, "rogue.dll"), "unlisted");
    await assert.rejects(workshop.launch(key, id), /Unlisted/);
    assert.equal((await workshop.engine.inspect(key)).revision, state.revision);
    await workshop.engine.activate(key, id, state.revision);
    assert.equal((await readdir(workshop.folder(key))).filter(name => /^[a-f0-9-]{36}$/.test(name)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
