// Actual Next route functions, owned PostgreSQL, canonical migrations and real
// immutable storage—not mocked success. Real pinned public source acquisition.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { missionPostgres } from "../helpers/mission-postgres.ts";
test("real source package survives actual API to immutable Artifact and full revision retrieval", { timeout: 90000 }, async t => {
  const receipt = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeClean: !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), scope: "Actual API functions, owned PostgreSQL/canonical migrations, immutable storage and real pinned upstream; browser play tested separately", status: "running" };
  let pg, appPool, root;
  t.after(async () => { await appPool?.end(); await pg?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  try {
    pg = await missionPostgres(); root = await mkdtemp(path.join(tmpdir(), "arena-source-storage-"));
    process.env.DATABASE_URL = pg.url; process.env.WAVEYARD_STORAGE_DIR = root; process.env.ARENA_DESKTOP_MODE = "1";
    const { POST } = await import("../../src/app/api/arcade/source/route.ts");
    const { GET } = await import("../../src/app/api/artifacts/[id]/route.ts");
    appPool = (await import("../../src/db/index.ts")).pool;
    const response = await POST(new Request("http://127.0.0.1:3000/api/arcade/source", { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify({ adapter: "2048", initialTiles: 3 }) }));
    const body = await response.json(); assert.equal(response.status, 200, body.error);
    assert.ok(body.artifactId, body.persistenceError); assert.equal(body.persistenceError, undefined);
    const original = JSON.stringify(body.bundle, null, 2);
    assert.ok(original.length > 20000, "the complete real package crosses the existing body limit");
    const stored = await GET(new Request(`http://127.0.0.1:3000${body.artifactDownloadUrl}`, { headers: { host: "127.0.0.1:3000" } }), { params: Promise.resolve({ id: body.artifactId }) });
    assert.equal(stored.status, 200); assert.equal(await stored.text(), original);
    const metadata = await (await GET(new Request(`http://127.0.0.1:3000/api/artifacts/${body.artifactId}`, { headers: { host: "127.0.0.1:3000" } }), { params: Promise.resolve({ id: body.artifactId }) })).json();
    assert.ok(metadata.artifact.body.length < 20000);
    assert.equal(metadata.artifact.contentObject.mediaType, "application/json; charset=utf-8");
    receipt.status = "passed"; receipt.completeCharacters = original.length; receipt.immutableObject = metadata.artifact.contentObject; receipt.artifactId = body.artifactId; receipt.manifestCharacters = metadata.artifact.body.length;
  } catch (error) { receipt.status = "failed"; receipt.error = String(error); throw error; }
  finally { await mkdir(".data/arcade-source", { recursive: true }); await writeFile(".data/arcade-source/storage-receipt.json", JSON.stringify(receipt, null, 2)); }
});
