// Native PostgreSQL + real private files + actual authorized HTTP handlers.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, pool, db, schema, store, objects, item, history, recovery, orchestration, sessions, storage, root;
const owner = "00000000-0000-4000-8000-000000000001";
function req(method = "GET", body, query = "", host = "localhost") { return new Request(`http://${host}/api/artifacts${query}`, { method, headers: { host, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
function context(id) { return { params: Promise.resolve({ id }) }; }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
before(async () => { root = await mkdtemp(path.join(tmpdir(), "arena-object-acceptance-")); process.env.WAVEYARD_STORAGE_DIR = root; f = await missionPostgres(); process.env.DATABASE_URL = f.url; ({ pool, db } = await import("../../src/db/index.ts")); schema = await import("../../src/db/schema.ts"); store = await import("../../src/lib/arcadeStore.ts"); objects = await import("../../src/lib/artifact-objects.ts"); item = await import("../../src/app/api/artifacts/[id]/route.ts"); history = await import("../../src/app/api/artifacts/[id]/history/route.ts"); recovery = await import("../../src/app/api/artifacts/storage/route.ts"); orchestration = await import("../../src/lib/orchestrator.ts"); sessions = await import("../../src/app/api/orchestrator/[id]/route.ts"); storage = (await import("../../src/lib/waveyard/storage.ts")).getStorage(); });
after(async () => { await pool?.end(); await f?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function save(bytes, mediaType, ownerId = owner) { const contentObject = await objects.writeArtifactObject(ownerId, bytes, mediaType); return store.insertArtifact(db, { ownerId, title: "Complete immutable content", body: objects.artifactObjectSummary(contentObject), contentObject, kind: "archive", sourceType: "controlled-storage-contract", sourceId: randomUUID() }); }
async function download(artifact, revisionId = artifact.currentRevisionId) { return item.GET(req("GET", null, `?revision=${revisionId}&download=1`), context(artifact.id)); }
async function inventory() { const response = await recovery.GET(req()); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).objects; }
test("large Unicode and binary records have bounded SQL previews, exact verified downloads, immutable IDs/history and survive SQL restart", async () => {
  for (const [bytes, mediaType] of [[Buffer.from("ORIGINAL UNICODE 🎵 中文 café\n".repeat(10000) + "IMPORTANT FULL SUFFIX"), "text/plain; charset=utf-8"], [Buffer.from(Array.from({ length: 240000 }, (_, i) => i % 256)), "application/octet-stream"]]) {
    const artifact = await save(bytes, mediaType); assert.ok(artifact.body.length < 1000); assert.equal(artifact.contentObject.bytes, bytes.length); assert.equal(artifact.contentObject.sha256, sha(bytes)); assert.equal(artifact.revision, 1);
    const response = await download(artifact); assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(bytes.length)); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.ok(!JSON.stringify(artifact).includes("owners/"));
    await f.stop(); await f.start(); assert.deepEqual(Buffer.from(await (await download(artifact)).arrayBuffer()), bytes);
    const edit = await item.PUT(req("PUT", { body: "Deliberate new inline revision", expectedRevision: 1 }), context(artifact.id)); assert.equal(edit.status, 200); assert.equal((await edit.json()).artifact.contentObject, null); assert.deepEqual(Buffer.from(await (await download(artifact)).arrayBuffer()), bytes);
    const restored = await history.POST(req("POST", { revisionId: artifact.currentRevisionId, expectedRevision: 2 }), context(artifact.id)); assert.equal(restored.status, 200, await restored.clone().text()); const current = (await restored.json()).artifact; assert.equal(current.revision, 3); assert.equal(current.contentObject.sha256, sha(bytes)); assert.deepEqual(Buffer.from(await (await download(current)).arrayBuffer()), bytes);
    assert.equal((await item.DELETE(req("DELETE"), context(artifact.id))).status, 200); assert.deepEqual(Buffer.from(await (await download(artifact)).arrayBuffer()), bytes);
    const battle = await import("../../src/app/api/battles/route.ts"); const unsupported = await battle.POST(req("POST", { source: `artifact:${artifact.id}@${artifact.currentRevisionId}`, prompt: "MUST NOT EXECUTE THIS METADATA PREVIEW", localOnly: true })); assert.equal(unsupported.status, 413); assert.equal((await pool.query("SELECT count(*) FROM battles")).rows[0].count, "0");
  }
});
test("interrupted/checksum-invalid streaming uploads publish neither partial objects nor SQL metadata; a bounded retry is exact", async () => {
  const bytes = Buffer.from("STREAMED PRIVATE CONTENT 🎵\n".repeat(5000)); const object = { version: 1, sha256: sha(bytes), bytes: bytes.length, mediaType: "text/plain; charset=utf-8" }; const before = await inventory();
  async function* interrupted() { yield bytes.subarray(0, 64000); throw new Error("actual source stream interrupted"); }
  await assert.rejects(() => objects.writeArtifactObjectStream(owner, interrupted(), object)); assert.deepEqual(await inventory(), before);
  async function* corrupt() { yield Buffer.alloc(bytes.length, 1); } await assert.rejects(() => objects.writeArtifactObjectStream(owner, corrupt(), object)); assert.deepEqual(await inventory(), before);
  async function* complete() { for (let offset = 0; offset < bytes.length; offset += 16384) yield bytes.subarray(offset, offset + 16384); }
  await objects.writeArtifactObjectStream(owner, complete(), object); const restored = await recovery.POST(req("POST", { sha256: object.sha256 })); assert.equal(restored.status, 201); const artifact = (await restored.json()).artifact; assert.deepEqual(Buffer.from(await (await download(artifact)).arrayBuffer()), bytes);
});
test("real large Orchestrator archive DB failure retains one unbound file; authorized recovery and original retry adopt it without duplicate bytes or invented origin", async () => {
  const session = await orchestration.createCollaboration({ title: "Retain every completed answer", goal: "Archive actual work rather than a clipped excerpt", context: "CONTEXT 🎵 ".repeat(500), participants: [{ key: "owner", name: "Owner", kind: "human" }] });
  for (let i = 0; i < 3; i++) { const relay = await orchestration.addRelay(session.id, { target: "owner", request: `Actual checkpoint ${i}` }); await orchestration.respondToRelay(relay.id, { response: "COMPLETE ANSWER 🎵 ".repeat(500) + `FULL SUFFIX ${i}` }); }
  const before = await inventory(); await pool.query("CREATE FUNCTION reject_large_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_type='orchestrator' THEN RAISE EXCEPTION 'injected after object publication'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_large_archive BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_large_archive()");
  let retained;
  try {
    const failed = await sessions.PATCH(req("PATCH", { status: "closed" }), context(session.id)); assert.equal(failed.status, 503); assert.equal((await orchestration.getCollaboration(session.id)).status, "running"); assert.equal((await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, session.id))).length, 0);
    const unbound = (await inventory()).filter(object => !before.some(previous => previous.id === object.id)); assert.equal(unbound.length, 1); assert.equal(unbound[0].state, "unbound"); retained = unbound[0];
    const content = await recovery.GET(req("GET", null, `?sha=${retained.sha256}`)); assert.equal(content.status, 200); const text = await content.text(); for (let i = 0; i < 3; i++) assert.ok(text.includes(`FULL SUFFIX ${i}`));
    const recovered = await Promise.all([recovery.POST(req("POST", { sha256: retained.sha256 })), recovery.POST(req("POST", { sha256: retained.sha256 }))]); const rows = await Promise.all(recovered.map(async response => { assert.equal(response.status, 201); return (await response.json()).artifact; })); assert.equal(rows[0].id, rows[1].id); assert.equal(rows[0].currentRevisionId, rows[1].currentRevisionId); assert.equal(rows[0].sourceType, "recovered-object"); assert.ok(!JSON.stringify(rows).includes(root));
  } finally { await pool.query("DROP TRIGGER reject_large_archive ON artifacts; DROP FUNCTION reject_large_archive()"); }
  const closed = await sessions.PATCH(req("PATCH", { status: "closed" }), context(session.id)); assert.equal(closed.status, 200); const result = (await closed.json()).collaboration; const artifact = (await (await item.GET(req(), context(session.id))).json()).artifact; assert.equal(artifact.contentObject.sha256, retained.sha256); assert.equal((await inventory()).length, before.length + 1); assert.equal((await inventory()).find(object => object.sha256 === retained.sha256).references, 2);
  await f.stop(); await f.start(); const repeated = await sessions.PATCH(req("PATCH", { status: "closed" }), context(session.id)); assert.equal((await repeated.json()).collaboration.archive.revisionId, result.archive.revisionId);
});
test("missing/corrupt/private/swapped content refuses download and restore without producing a replacement revision or overwriting bytes", async () => {
  const bytes = Buffer.from("EXACT CONTENT FOR FAILURE BOUNDARIES 🎵".repeat(2000)); const artifact = await save(bytes, "text/plain; charset=utf-8"); const filename = storage.getLocalPath(objects.artifactObjectKey(owner, artifact.contentObject));
  await rename(filename, filename + ".missing"); try { assert.equal((await download(artifact)).status, 410); const restore = await history.POST(req("POST", { revisionId: artifact.currentRevisionId, expectedRevision: 1 }), context(artifact.id)); assert.equal(restore.status, 410); } finally { await rename(filename + ".missing", filename); }
  const bad = Buffer.from(bytes); bad[0] ^= 1; await writeFile(filename, bad); try { assert.equal((await download(artifact)).status, 422); assert.equal((await history.POST(req("POST", { revisionId: artifact.currentRevisionId, expectedRevision: 1 }), context(artifact.id))).status, 422); await assert.rejects(() => objects.writeArtifactObject(owner, bytes)); assert.deepEqual(await readFile(filename), bad); } finally { await writeFile(filename, bytes); }
  const foreign = await save(Buffer.from("FOREIGN PRIVATE DATA ONLY".repeat(1500)), "text/plain; charset=utf-8", "foreign-owner"); assert.equal((await download(foreign)).status, 404); assert.equal((await recovery.GET(req("GET", null, `?sha=${foreign.contentObject.sha256}`))).status, 404);
  const [revision] = await db.select().from(schema.artifactRevisions).where(eq(schema.artifactRevisions.id, artifact.currentRevisionId)); await db.update(schema.artifactRevisions).set({ snapshot: { ...revision.snapshot, contentObject: foreign.contentObject } }).where(eq(schema.artifactRevisions.id, revision.id)); assert.equal((await download(artifact)).status, 422); await db.update(schema.artifactRevisions).set({ snapshot: revision.snapshot }).where(eq(schema.artifactRevisions.id, revision.id));
  assert.equal((await db.select().from(schema.artifactRevisions).where(eq(schema.artifactRevisions.artifactId, artifact.id))).length, 1); assert.equal((await recovery.GET(req("GET", null, "", "untrusted.example"))).status, 401);
});

test("retention inventory preserves current legacy roots, owner disagreements, history and tombstones instead of misclassifying them as unbound", async () => {
  const bytes = Buffer.from("CURRENT ROOT WITHOUT HISTORICAL BASELINE 🎵");
  const contentObject = await objects.writeArtifactObject(owner, bytes);
  const [legacy] = await db.insert(schema.artifacts).values({ ownerId: owner, title: "Legacy current root", body: objects.artifactObjectSummary(contentObject), contentObject, kind: "archive" }).returning();
  let entry = (await inventory()).find(row => row.sha256 === contentObject.sha256);
  assert.equal(entry.state, "uncertain"); assert.equal(entry.references, 1); assert.deepEqual(entry.referenceKinds, ["current"]);
  assert.deepEqual(await readFile(storage.getLocalPath(objects.artifactObjectKey(owner, contentObject))), bytes);
  // The existing real History operation establishes the missing baseline; no
  // second registry, invented revision, or separate recovery writer is needed.
  assert.equal((await history.GET(req(), context(legacy.id))).status, 200);
  entry = (await inventory()).find(row => row.sha256 === contentObject.sha256);
  assert.equal(entry.state, "referenced"); assert.equal(entry.references, 1);
  const current = (await (await item.GET(req(), context(legacy.id))).json()).artifact;
  await item.PUT(req("PUT", { body: "Replace only the current inline text", expectedRevision: current.revision }), context(legacy.id));
  entry = (await inventory()).find(row => row.sha256 === contentObject.sha256);
  assert.equal(entry.state, "referenced"); assert.deepEqual(entry.referenceKinds, ["history"]);
  assert.equal((await item.DELETE(req("DELETE"), context(legacy.id))).status, 200);
  entry = (await inventory()).find(row => row.sha256 === contentObject.sha256);
  assert.equal(entry.state, "referenced"); assert.deepEqual(entry.referenceKinds, ["tombstone"]);
  const disagreementBytes = Buffer.from("CURRENT OWNER AND SNAPSHOT OWNER DISAGREE: PRESERVE ME");
  const other = await save(disagreementBytes, "text/plain; charset=utf-8");
  const [revision] = await db.select().from(schema.artifactRevisions).where(eq(schema.artifactRevisions.id, other.currentRevisionId));
  await db.update(schema.artifactRevisions).set({ snapshot: { ...revision.snapshot, ownerId: "foreign-owner" } }).where(eq(schema.artifactRevisions.id, revision.id));
  entry = (await inventory()).find(row => row.sha256 === other.contentObject.sha256);
  assert.equal(entry.state, "uncertain"); assert.equal(entry.references, 1);
  assert.equal((await download(other)).status, 422, "classification never authorizes corrupt history retrieval");
  await f.stop(); await f.start();
  entry = (await inventory()).find(row => row.sha256 === other.contentObject.sha256); assert.equal(entry.state, "uncertain");
  assert.deepEqual(await readFile(storage.getLocalPath(objects.artifactObjectKey(owner, other.contentObject))), disagreementBytes);
  await db.update(schema.artifactRevisions).set({ snapshot: revision.snapshot }).where(eq(schema.artifactRevisions.id, revision.id));
  assert.deepEqual(Buffer.from(await (await download(other)).arrayBuffer()), disagreementBytes);
  assert.equal((await inventory()).find(row => row.sha256 === other.contentObject.sha256).state, "referenced");
});
