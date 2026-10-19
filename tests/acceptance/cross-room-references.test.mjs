// Real handlers + native PostgreSQL + deterministic Local Engine (not inference).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, db, pool, store, schema;
const routes = [];
const owner = "00000000-0000-4000-8000-000000000001";
const modes = [["battles", "prompt", "battle"], ["battles/stream", "prompt", "battle"], ["collabs", "challenge", "collab"], ["council", "material", "run"]];
function request(body, host = "localhost") { return new Request(`http://${host}/api/test`, { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ localOnly: true, modelAId: "openai", modelBId: "deepseek", ...body }) }); }
before(async () => { f = await missionPostgres(); process.env.DATABASE_URL = f.url; ({ db, pool } = await import("../../src/db/index.ts")); store = await import("../../src/lib/arcadeStore.ts"); schema = await import("../../src/db/schema.ts"); for (const [path] of modes) routes.push(await import(`../../src/app/api/${path}/route.ts`)); });
after(async () => { await pool?.end(); await f?.close(); });
async function create(body = "ORIGINAL PINNED EVIDENCE 🎵", ownerId = owner) { return store.insertArtifact(db, { title: "Recognisable immutable work", body, kind: "brief", sourceType: "manual", ownerId }); }
async function execute(index, body) { const response = await routes[index].POST(request(body)); if (modes[index][0].endsWith("stream") && response.ok) { const events = (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))); const event = events.find(event => event.type === "battle"); assert.ok(event, JSON.stringify(events)); return { status: response.status, data: event }; } return { status: response.status, data: await response.json() }; }
for (let index = 0; index < modes.length; index++) {
  const [room, field, output] = modes[index];
  test(`${room}: actual execution uses the owned pinned revision, never the client excerpt or later edit`, async () => {
    const original = await create(); const source = `artifact:${original.id}@${original.currentRevisionId}`;
    await store.updateArtifact(db, original.id, owner, { body: "MUTABLE LATEST MUST NOT RUN" }, 1);
    const result = await execute(index, { [field]: "CLIENT OVERRIDE MUST NOT RUN", source }); assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
    const operation = result.data[output]; assert.equal(operation[field], original.body); assert.equal(operation.inputReference.reference, source); assert.equal(operation.inputReference.sha256, createHash("sha256").update(original.body).digest("hex"));
    const table = room.startsWith("battles") ? schema.battles : room === "collabs" ? schema.collabs : schema.councilRuns;
    const [persisted] = await db.select().from(table).where(eq(table.id, operation.id)); assert.deepEqual(persisted.inputReference, operation.inputReference); assert.equal(persisted[field], original.body);
    const execution = room.startsWith("battles") ? operation.responseA : room === "collabs" ? result.data.contributions[0].content : operation.perspectiveA;
    assert.match(execution, /ORIGINAL PINNED EVIDENCE/); assert.doesNotMatch(execution, /CLIENT OVERRIDE|MUTABLE LATEST/);
    const concurrent = await Promise.all([execute(index, { [field]: "CLIENT OVERRIDE", source }), store.updateArtifact(db, original.id, owner, { body: "CONCURRENT EDIT MUST NOT CHANGE SELECTED REVISION" }, 2)]); assert.equal(concurrent[0].data[output][field], original.body);
    await store.deleteArtifact(db, original.id, owner); const retained = await execute(index, { [field]: "bad", source }); assert.ok([200, 201].includes(retained.status)); assert.equal(retained.data[output][field], original.body);
    await f.stop(); await f.start(); const [reopened] = await db.select().from(table).where(eq(table.id, operation.id)); assert.deepEqual(reopened.inputReference, operation.inputReference);
  });
  test(`${room}: foreign, missing, wrong-revision, unbound and corrupted references fail before operation creation`, async () => {
    const original = await create(); const foreign = await create("FOREIGN PRIVATE", "foreign-owner"); const other = await create();
    const before = await operationCounts();
    for (const [source, status] of [[`artifact:${original.id}`, 400], [`battle:${randomUUID()}`, 400], [`artifact:${randomUUID()}@${randomUUID()}`, 404], [`artifact:${original.id}@${other.currentRevisionId}`, 404], [`artifact:${foreign.id}@${foreign.currentRevisionId}`, 404]]) { const result = await execute(index, { [field]: "Never run", source }); assert.equal(result.status, status, JSON.stringify(result.data)); }
    await db.update(schema.artifactRevisions).set({ snapshot: { ...original, ownerId: owner, body: "VALID STRING BUT CORRUPTED BYTES" } }).where(eq(schema.artifactRevisions.id, original.currentRevisionId));
    assert.equal((await execute(index, { [field]: "Never run", source: `artifact:${original.id}@${original.currentRevisionId}` })).status, 422);
    assert.equal((await routes[index].POST(request({ [field]: "Never run" }, "untrusted.example"))).status, 401);
    assert.deepEqual(await operationCounts(), before);
  });
}

async function operationCounts() { return (await pool.query("SELECT (SELECT count(*) FROM battles) battles, (SELECT count(*) FROM collabs) collabs, (SELECT count(*) FROM council_runs) council_runs, (SELECT count(*) FROM artifacts) artifacts, (SELECT count(*) FROM artifact_revisions) revisions")).rows[0]; }
test("all four actual POST paths fail truthfully on revision-storage outage without any operation or Artifact write", async () => {
  const original = await create(); const before = await operationCounts();
  await pool.query("ALTER TABLE artifact_revisions RENAME TO unavailable_artifact_revisions");
  try { for (let i = 0; i < modes.length; i++) { const result = await execute(i, { [modes[i][1]]: "MUST NOT RUN", source: `artifact:${original.id}@${original.currentRevisionId}` }); assert.equal(result.status, 503, JSON.stringify(result.data)); } } finally { await pool.query("ALTER TABLE unavailable_artifact_revisions RENAME TO artifact_revisions"); }
  assert.deepEqual(await operationCounts(), before);
});
