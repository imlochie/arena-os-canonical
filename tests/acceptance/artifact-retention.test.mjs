// Actual API handlers + native PostgreSQL. No provider or browser claim.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let fixture, collection, item, pool;
before(async () => {
  fixture = await missionPostgres(); process.env.DATABASE_URL = fixture.url;
  collection = await import("../../src/app/api/artifacts/route.ts");
  item = await import("../../src/app/api/artifacts/[id]/route.ts");
  pool = (await import("../../src/db/index.ts")).pool;
});
after(async () => { await pool?.end(); await fixture?.close(); });
function request(method, body) { return new Request("http://localhost/api/artifacts", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
test("oversized creation is refused explicitly without a truncated SQL artifact", async () => {
  const response = await collection.POST(request("POST", { title: "Never truncate generated output", body: "x".repeat(20000) + "IMPORTANT SUFFIX" }));
  assert.equal(response.status, 413); assert.match((await response.json()).error, /Nothing was saved/);
  const rows = await collection.GET(request("GET")); assert.equal(rows.status, 200); assert.deepEqual((await rows.json()).artifacts, []);
});
test("exact-limit Unicode output round-trips; oversized edits preserve every previous field and successful retry is retrievable", async () => {
  const body = "é".repeat(19998) + "🎵";
  const created = await collection.POST(request("POST", { title: "Retained original", body })); assert.equal(created.status, 201);
  const { artifact } = await created.json(); assert.equal(artifact.body, body);
  const params = { params: Promise.resolve({ id: artifact.id }) };
  const rejected = await item.PUT(request("PUT", { title: "Must not apply partial metadata", body: body + "critical suffix" }), params);
  assert.equal(rejected.status, 413); assert.match((await rejected.json()).error, /not changed/);
  const retained = (await (await item.GET(request("GET"), params)).json()).artifact;
  assert.equal(retained.body, body); assert.equal(retained.title, "Retained original");
  const retry = await item.PUT(request("PUT", { body: "Owner-authorized shorter revision 🎵", title: "Explicit revision", expectedRevision: artifact.revision }), params); assert.equal(retry.status, 200);
  const saved = (await (await item.GET(request("GET"), params)).json()).artifact;
  assert.equal(saved.body, "Owner-authorized shorter revision 🎵"); assert.equal(saved.title, "Explicit revision");
});

test("actual handlers retain immutable history, detect racing edits, restore and recover tombstones across SQL restart", async () => {
  const history = await import("../../src/app/api/artifacts/[id]/history/route.ts");
  const { db } = await import("../../src/db/index.ts"); const { artifacts, artifactRevisions } = await import("../../src/db/schema.ts"); const { eq } = await import("drizzle-orm");
  const created = await collection.POST(request("POST", { title: "Mission evidence", body: "original work", sourceType: "controlled-contract", sourceId: "operation-immutable-reference" })); assert.equal(created.status, 201);
  const original = (await created.json()).artifact; const ctx = { params: Promise.resolve({ id: original.id }) }; assert.equal(original.revision, 1); assert.ok(original.currentRevisionId);
  async function edit(body, expectedRevision, title = "Revised evidence") { return item.PUT(request("PUT", { body, title, expectedRevision }), ctx); }
  const changed = await edit("second work", 1); assert.equal(changed.status, 200); const second = (await changed.json()).artifact; assert.equal(second.revision, 2);
  const unchanged = await edit("second work", 2); assert.equal((await unchanged.json()).artifact.revision, 2);
  const races = await Promise.all([edit("racer A", 2), edit("racer B", 2)]); assert.deepEqual(races.map((row) => row.status).sort(), [200, 409]);
  const listed = (await (await history.GET(request("GET"), ctx)).json()).revisions; assert.deepEqual(listed.map((row) => row.revision), [3, 2, 1]); assert.equal(listed[2].snapshot.body, "original work"); assert.equal(listed[2].id, original.currentRevisionId);
  const downloaded = await item.GET(new Request(`http://localhost/api/artifacts/${original.id}?revision=${original.currentRevisionId}&download=1`, { headers: { host: "localhost" } }), ctx); assert.equal(await downloaded.text(), "original work");
  const restored = await history.POST(request("POST", { revisionId: original.currentRevisionId, expectedRevision: 3 }), ctx); assert.equal(restored.status, 200); assert.equal((await restored.json()).artifact.revision, 4);
  await fixture.stop(); let unavailable; try { unavailable = await history.GET(request("GET"), ctx); } finally { await fixture.start(); } assert.equal(unavailable.status, 503);
  const reopened = (await (await item.GET(request("GET"), ctx)).json()).artifact; assert.equal(reopened.body, "original work"); assert.equal(reopened.sourceId, "operation-immutable-reference");
  assert.equal((await edit("x".repeat(20001), 4, "must not apply")).status, 413);
  // A real SQL failure after history INSERT must roll back both history and head.
  await fixture.pool.query(`CREATE FUNCTION reject_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected SQL write failure'; END; $$; CREATE TRIGGER reject_artifact_update BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_artifact_update();`);
  try { assert.equal((await edit("must roll back", 4)).status, 503); } finally { await fixture.pool.query("DROP TRIGGER reject_artifact_update ON artifacts; DROP FUNCTION reject_artifact_update();"); }
  assert.equal((await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, original.id))).length, 4);
  assert.equal((await item.DELETE(request("DELETE"), ctx)).status, 200); assert.equal((await item.GET(request("GET"), ctx)).status, 404);
  const deletedHistory = (await (await history.GET(request("GET"), ctx)).json()).revisions; assert.equal(deletedHistory.length, 5);
  const recovery = await history.POST(request("POST", { revisionId: second.currentRevisionId, expectedRevision: 5 }), ctx); assert.equal(recovery.status, 200); assert.equal((await recovery.json()).artifact.body, "second work");
  // Foreign owners cannot retrieve current content, history, or a guessed revision.
  await db.update(artifacts).set({ ownerId: "foreign-owner" }).where(eq(artifacts.id, original.id));
  assert.equal((await history.GET(request("GET"), ctx)).status, 404);
  assert.equal((await history.POST(request("POST", { revisionId: original.currentRevisionId, expectedRevision: 6 }), ctx)).status, 404);
  assert.equal((await item.GET(new Request(`http://localhost/api/artifacts/${original.id}?revision=${original.currentRevisionId}`, { headers: { host: "localhost" } }), ctx)).status, 404);
});

test("later mission dispatch reads a pinned Artifact revision, not mutable latest, and reuses the actual recorded result", async () => {
  const runtime = await import("../../src/lib/spaces/mission.ts"); const tools = await import("../../src/lib/spaces/tools.ts"); const { spaces } = await import("../../src/db/schema.ts");
  const { randomUUID } = await import("node:crypto"); const { readFile, rm } = await import("node:fs/promises"); const path = await import("node:path");
  const response = await collection.POST(request("POST", { title: "Immutable source", body: "Original useful evidence from first task" })); const original = (await response.json()).artifact;
  const ctx = { params: Promise.resolve({ id: original.id }) };
  assert.equal((await item.PUT(request("PUT", { body: "Unrelated newer wording", expectedRevision: 1 }), ctx)).status, 200);
  const id = randomUUID(); await fixture.database.insert(spaces).values({ id, prompt: "Authorised immutable reuse" }); let calls = 0;
  try {
    const mission = await runtime.runMission(id, { goal: "Read pinned revision and create a reusable report", isolation: "host", maxTurnsPerAgent: 2, agentPlan: [{ name: "Contract worker", role: "worker", modelId: "controlled-protocol" }] }, { generate: async () => {
      let actions, done = false;
      if (++calls === 1) actions = [{ tool: "read_artifact", args: { artifactId: original.id, revisionId: original.currentRevisionId } }];
      else { const prior = await runtime.getLatestMission(id); const actual = JSON.parse(prior.journal[0].actions[0].output); assert.equal(actual.body, "Original useful evidence from first task"); actions = [{ tool: "write_file", args: { path: "reused-evidence.txt", content: actual.body } }]; done = true; }
      return { text: JSON.stringify({ actions, done }), backend: "controlled-protocol", modelId: "not-real-reasoning", runtimeLevel: "arena-local", via: "controlled-test", ms: 0, fallback: false };
    } });
    assert.equal(mission.status, "done"); assert.equal(mission.journal[0].actions[0].input.revisionId, original.currentRevisionId);
    assert.equal(await readFile(path.join(tools.workspaceDir(id), "reused-evidence.txt"), "utf8"), "Original useful evidence from first task");
    const unbound = await tools.executeTool(id, { tool: "read_artifact", args: { artifactId: original.id } }); assert.equal(unbound.ok, false); assert.match(unbound.output, /unbound/);
  } finally { await rm(tools.workspaceDir(id), { recursive: true, force: true }); }
});
