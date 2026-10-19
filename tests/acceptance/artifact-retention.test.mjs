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

test("project creation rejects oversized bodies atomically; project/context/Command/assistant reads share owner and tombstone boundaries", async () => {
  const { db } = await import("../../src/db/index.ts"); const { projects, artifacts, LOCAL_OWNER_ID } = await import("../../src/db/schema.ts");
  const { insertArtifact } = await import("../../src/lib/arcadeStore.ts"); const { getProjectContext } = await import("../../src/lib/projectContext.ts"); const { getTool } = await import("../../src/lib/assistantTools.ts");
  const projectRoute = await import("../../src/app/api/projects/[id]/route.ts"); const projectArtifacts = await import("../../src/app/api/projects/[id]/artifacts/route.ts"); const projectIndex = await import("../../src/app/api/projects/route.ts"); const command = await import("../../src/app/api/command/route.ts"); const { eq } = await import("drizzle-orm");
  const [project] = await db.insert(projects).values({ name: "Scoped project" }).returning(); const ctx = { params: Promise.resolve({ id: project.id }) };
  const rejected = await projectArtifacts.POST(request("POST", { title: "Never silently truncate", body: "x".repeat(20000) + "critical suffix" }), ctx); assert.equal(rejected.status, 413);
  assert.equal((await db.select().from(artifacts).where(eq(artifacts.projectId, project.id))).length, 0); assert.equal((await db.select().from(projects).where(eq(projects.id, project.id)))[0].updatedAt.toISOString(), project.updatedAt.toISOString());
  assert.equal((await projectArtifacts.POST(request("POST", { title: "Forged origin", body: "not mission execution", sourceType: "mission-output" }), ctx)).status, 400);
  const visible = await insertArtifact(db, { title: "Owned active", body: "Visible evidence", kind: "brief", sourceType: "manual", ownerId: LOCAL_OWNER_ID, projectId: project.id });
  const foreign = await insertArtifact(db, { title: "FOREIGN PRIVATE SECRET", body: "foreign hidden evidence", kind: "brief", sourceType: "manual", ownerId: "foreign-project-owner", projectId: project.id });
  const removed = await insertArtifact(db, { title: "TOMBSTONE PRIVATE SECRET", body: "deleted hidden evidence", kind: "brief", sourceType: "manual", ownerId: LOCAL_OWNER_ID, projectId: project.id });
  assert.equal((await item.DELETE(request("DELETE"), { params: Promise.resolve({ id: removed.id }) })).status, 200);
  for (const route of [projectRoute, projectArtifacts]) { const result = await route.GET(request("GET"), ctx); assert.equal(result.status, 200); assert.deepEqual((await result.json()).artifacts.map(row => row.id), [visible.id]); }
  const context = await getProjectContext(project.id); assert.equal(context.counts.artifacts, 1); assert.doesNotMatch(context.memoryBlock, /FOREIGN PRIVATE|TOMBSTONE PRIVATE|foreign hidden|deleted hidden/);
  const index = await (await projectIndex.GET(request("GET"))).json(); assert.equal(index.projects.find(row => row.id === project.id).counts.artifacts, 1);
  const dashboard = await (await command.GET(request("GET"))).json(); assert.doesNotMatch(JSON.stringify(dashboard), /FOREIGN PRIVATE|TOMBSTONE PRIVATE/);
  const browsed = await getTool("list_artifacts").run({ limit: 100 }, {}); assert.ok(browsed.some(row => row.id === visible.id)); assert.ok(!browsed.some(row => row.id === foreign.id || row.id === removed.id));
  // Direct handlers also reject cross-origin/private-host requests, not just
  // relying on a front-end middleware to happen to protect project data.
  const denied = await projectRoute.GET(new Request("http://untrusted.example/api/projects", { headers: { host: "untrusted.example" } }), ctx); assert.ok([401, 403].includes(denied.status));
});

test("project deletion is atomic, preserves live and deleted Artifact histories, and original revisions recover without a deleted-project FK", async () => {
  const { db } = await import("../../src/db/index.ts"); const { projects, artifacts, artifactRevisions, projectMemory, LOCAL_OWNER_ID } = await import("../../src/db/schema.ts"); const { eq } = await import("drizzle-orm"); const { insertArtifact } = await import("../../src/lib/arcadeStore.ts");
  const projectRoute = await import("../../src/app/api/projects/[id]/route.ts"); const history = await import("../../src/app/api/artifacts/[id]/history/route.ts");
  const [project] = await db.insert(projects).values({ name: "Preserve project work" }).returning(); const ctx = { params: Promise.resolve({ id: project.id }) };
  await db.insert(projectMemory).values({ projectId: project.id, content: "Retain this if deletion fails" });
  const common = { body: "retained original bytes 🎵", kind: "brief", sourceType: "manual", ownerId: LOCAL_OWNER_ID, projectId: project.id };
  const active = await insertArtifact(db, { ...common, title: "Retain live work" }); const deleted = await insertArtifact(db, { ...common, title: "Fail this unlink" }); const deletedCtx = { params: Promise.resolve({ id: deleted.id }) };
  assert.equal((await item.DELETE(request("DELETE"), deletedCtx)).status, 200);
  await fixture.pool.query(`CREATE FUNCTION reject_project_unlink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.title = 'Fail this unlink' THEN RAISE EXCEPTION 'injected unlink failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_project_unlink BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_project_unlink();`);
  try { assert.equal((await projectRoute.DELETE(request("DELETE"), ctx)).status, 503); } finally { await fixture.pool.query("DROP TRIGGER reject_project_unlink ON artifacts; DROP FUNCTION reject_project_unlink();"); }
  assert.equal((await db.select().from(projectMemory).where(eq(projectMemory.projectId, project.id))).length, 1); assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 1);
  assert.equal((await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, active.id))).length, 1); assert.equal((await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, deleted.id))).length, 2);
  assert.equal((await projectRoute.DELETE(request("DELETE"), ctx)).status, 200);
  for (const [original, revision] of [[active, 2], [deleted, 3]]) {
    const [current] = await db.select().from(artifacts).where(eq(artifacts.id, original.id)); assert.equal(current.body, common.body); assert.equal(current.projectId, null); assert.equal(current.revision, revision);
    const versions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, original.id)); assert.equal(versions.length, revision); assert.equal(versions.find(row => row.id === original.currentRevisionId).snapshot.projectId, project.id);
  }
  const recovered = await history.POST(request("POST", { revisionId: deleted.currentRevisionId, expectedRevision: 3 }), deletedCtx); assert.equal(recovered.status, 200); const restored = (await recovered.json()).artifact; assert.equal(restored.revision, 4); assert.equal(restored.body, common.body); assert.equal(restored.projectId, null); assert.equal(restored.deletedAt, null);
  const [foreignProject] = await db.insert(projects).values({ name: "Do not mutate another owner" }).returning(); await db.insert(projectMemory).values({ projectId: foreignProject.id, content: "Must survive ownership refusal" });
  const foreign = await insertArtifact(db, { ...common, title: "Foreign work", ownerId: "other-owner", projectId: foreignProject.id });
  const refused = await projectRoute.DELETE(request("DELETE"), { params: Promise.resolve({ id: foreignProject.id }) }); assert.equal(refused.status, 409); assert.match((await refused.json()).error, /another owner/);
  assert.equal((await db.select().from(projectMemory).where(eq(projectMemory.projectId, foreignProject.id))).length, 1); const [unchanged] = await db.select().from(artifacts).where(eq(artifacts.id, foreign.id)); assert.equal(unchanged.projectId, foreignProject.id); assert.equal(unchanged.revision, 1);
});

test("Archive Assistant saves real immutable revisions, refuses truncation and unbound reads, and retrieves pinned original content after edits", async () => {
  const { getTool } = await import("../../src/lib/assistantTools.ts");
  const rejected = await getTool("save_artifact").run({ title: "Keep suffix", body: "x".repeat(30001) + "NEVER DISCARD" }, {}); assert.equal(rejected.ok, false); assert.match(rejected.note, /20,000/);
  const saved = await getTool("save_artifact").run({ title: "Tool-produced work", body: "Original tool content 🎵" }, {}); assert.equal(saved.ok, true); assert.equal(saved.revision, 1); assert.ok(saved.revisionId);
  assert.equal((await item.PUT(request("PUT", { body: "New unrelated content", expectedRevision: 1 }), { params: Promise.resolve({ id: saved.id }) })).status, 200);
  const read = await getTool("read_artifact").run({ artifactId: saved.id, revisionId: saved.revisionId }, {}); assert.equal(read.ok, true); assert.equal(read.revision.snapshot.body, "Original tool content 🎵");
  assert.equal((await getTool("read_artifact").run({ artifactId: saved.id }, {})).ok, false);
  const { db } = await import("../../src/db/index.ts"); const { insertArtifact } = await import("../../src/lib/arcadeStore.ts"); const foreign = await insertArtifact(db, { title: "Private", body: "Must not read", kind: "brief", sourceType: "manual", ownerId: "other-owner" });
  assert.equal((await getTool("read_artifact").run({ artifactId: foreign.id, revisionId: foreign.currentRevisionId }, {})).ok, false);
});

test("Orchestrator dispatch consumes the owned immutable revision through actual HTTP and persists its provenance; unbound and foreign references never reach the adapter", async (t) => {
  const http = await import("node:http"); let received = [];
  const server = http.createServer(async (req, res) => { const parts = []; for await (const part of req) parts.push(part); received.push(JSON.parse(Buffer.concat(parts).toString())); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "Controlled adapter acknowledged the supplied evidence; no inference claim." } }] })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const orchestration = await import("../../src/lib/orchestrator.ts");
  const saved = (await (await collection.POST(request("POST", { title: "Dispatch source", body: "ORIGINAL IMMUTABLE DISPATCH EVIDENCE 🎵" }))).json()).artifact;
  assert.equal((await item.PUT(request("PUT", { body: "MUTABLE LATEST MUST NOT BE SENT", expectedRevision: 1 }), { params: Promise.resolve({ id: saved.id }) })).status, 200);
  const reference = `artifact:${saved.id}@${saved.currentRevisionId}`;
  const collaboration = await orchestration.createCollaboration({ title: "Pinned contract relay", goal: "Inspect durable original evidence", participants: [{ key: "adapter", name: "Controlled protocol adapter", kind: "external", trust: "internal", adapterUrl: `http://127.0.0.1:${server.address().port}` }], relay: { target: "adapter", request: "Use the pinned evidence", contextRefs: [reference], classification: "internal" } });
  const dispatched = await orchestration.advanceCollaboration(collaboration.id, { localOnly: true }); assert.equal(dispatched.ran, "relay"); assert.equal(received.length, 1);
  assert.match(received[0].messages[1].content, /ORIGINAL IMMUTABLE DISPATCH EVIDENCE/); assert.doesNotMatch(received[0].messages[1].content, /MUTABLE LATEST MUST NOT BE SENT/); assert.ok(received[0].messages[1].content.includes(reference));
  await fixture.stop(); await fixture.start();
  const { db: retainedDb } = await import("../../src/db/index.ts"); const { collaborationRelays } = await import("../../src/db/schema.ts"); const { eq: equals } = await import("drizzle-orm");
  const [durable] = await retainedDb.select().from(collaborationRelays).where(equals(collaborationRelays.collaborationId, collaboration.id)); assert.equal(durable.contextRefs, reference); assert.equal(durable.status, "responded");
  const reopened = await orchestration.getCollaboration(collaboration.id); assert.deepEqual(reopened.relays[0].contextRefs, [reference]); assert.equal(reopened.relays[0].status, "responded");
  await assert.rejects(() => orchestration.addRelay(collaboration.id, { target: "adapter", request: "Must not read mutable current", contextRefs: [saved.id] }), /immutable.*revision|pinned/i);
  const { db } = await import("../../src/db/index.ts"); const { insertArtifact } = await import("../../src/lib/arcadeStore.ts"); const foreign = await insertArtifact(db, { title: "Foreign", body: "PRIVATE FOREIGN", kind: "brief", sourceType: "manual", ownerId: "other-owner" });
  const blocked = await orchestration.addRelay(collaboration.id, { target: "adapter", request: "Must not transmit foreign data", contextRefs: [`artifact:${foreign.id}@${foreign.currentRevisionId}`] });
  const refused = await orchestration.advanceCollaboration(collaboration.id, { localOnly: true }); assert.equal(refused.ran, "blocked-relay"); assert.match(refused.note, /unavailable|owned/); assert.equal(received.length, 1); assert.equal(refused.collaboration.relays.find(row => row.id === blocked.id).status, "failed");
  await retainedDb.update(collaborationRelays).set({ contextRefs: saved.id, status: "pending" }).where(equals(collaborationRelays.id, blocked.id));
  const legacy = await orchestration.advanceCollaboration(collaboration.id, { localOnly: true }); assert.equal(legacy.ran, "blocked-relay"); assert.match(legacy.note, /unbound/); assert.equal(received.length, 1);
  const remote = await orchestration.createCollaboration({ title: "Local-only boundary", goal: "Must not contact a remote adapter", participants: [{ key: "remote", name: "Not an available provider", kind: "external", trust: "internal", adapterUrl: "https://not-contacted.invalid" }], relay: { target: "remote", request: "Must be refused before outbound HTTP" } });
  const localOnly = await orchestration.advanceCollaboration(remote.id, { localOnly: true }); assert.equal(localOnly.ran, "blocked-relay"); assert.match(localOnly.note, /Local-only/);
  for (const [routePath, methods] of [["orchestrator", ["GET", "POST"]], ["orchestrator/[id]", ["GET", "PATCH", "DELETE"]], ["orchestrator/[id]/relays", ["POST"]], ["orchestrator/[id]/advance", ["POST"]]]) {
    const routes = await import(`../../src/app/api/${routePath}/route.ts`);
    for (const method of methods) {
      const denied = await routes[method](new Request("http://untrusted.example/api/orchestrator", { method, headers: { host: "untrusted.example", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) }), { params: Promise.resolve({ id: collaboration.id }) }); assert.ok([401, 403].includes(denied.status));
    }
  }
});

test("Orchestrator archival is atomic, complete rather than clipped, retry-idempotent and downloadable; large retained records use complete immutable private objects", async () => {
  const root = await import("../../src/app/api/orchestrator/route.ts"); const route = await import("../../src/app/api/orchestrator/[id]/route.ts"); const answer = await import("../../src/app/api/orchestrator/relays/[relayId]/route.ts"); const orchestration = await import("../../src/lib/orchestrator.ts");
  const { db } = await import("../../src/db/index.ts"); const { artifacts, artifactRevisions } = await import("../../src/db/schema.ts"); const { eq } = await import("drizzle-orm");
  const context = "c".repeat(1800) + "KEEP ENTIRE CONTEXT 🎵", relayRequest = "q".repeat(1400) + "KEEP ENTIRE REQUEST", response = "a".repeat(3000) + "KEEP ENTIRE RESPONSE 🎵";
  const created = await root.POST(request("POST", { title: "Atomic archive", goal: "Preserve complete retained work", context, participants: [{ key: "owner", name: "Owner", kind: "human" }], relay: { target: "owner", request: relayRequest } })); assert.equal(created.status, 201); const { collaboration } = await created.json(); const ctx = { params: Promise.resolve({ id: collaboration.id }) };
  assert.equal((await route.PATCH(request("PATCH", { status: "closed" }), ctx)).status, 409);
  assert.equal((await answer.POST(request("POST", { response }), { params: Promise.resolve({ relayId: collaboration.relays[0].id }) })).status, 200);
  for (const [table, operation] of [["artifacts", "INSERT"], ["collaborations", "UPDATE"]]) {
    await fixture.pool.query(`CREATE FUNCTION fail_atomic_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected archive boundary failure'; END; $$; CREATE TRIGGER fail_atomic_archive BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_atomic_archive();`);
    try { assert.equal((await route.PATCH(request("PATCH", { status: "closed" }), ctx)).status, 503); }
    finally { await fixture.pool.query(`DROP TRIGGER fail_atomic_archive ON ${table}; DROP FUNCTION fail_atomic_archive();`); }
    assert.equal((await db.select().from(artifacts).where(eq(artifacts.id, collaboration.id))).length, 0); assert.equal((await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, collaboration.id))).length, 0); assert.equal((await (await route.GET(request("GET"), ctx)).json()).collaboration.status, "running");
  }
  const closed = await route.PATCH(request("PATCH", { status: "closed" }), ctx); assert.equal(closed.status, 200); const record = (await closed.json()).collaboration; assert.equal(record.status, "closed"); assert.equal(record.archive.artifactId, collaboration.id); assert.ok(record.archive.revisionId);
  const archived = (await (await item.GET(request("GET"), ctx)).json()).artifact; assert.equal(archived.revision, 1); const full = JSON.parse(archived.body.split("Retained collaboration record (JSON):\n\n")[1]); assert.equal(full.context, context); assert.equal(full.relays[0].request, relayRequest); assert.equal(full.relays[0].response, response);
  const download = await route.GET(new Request(`http://localhost/api/orchestrator/${collaboration.id}?download=1`, { headers: { host: "localhost" } }), ctx); assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /attachment/); assert.equal((await download.json()).relays[0].response, response);
  const duplicates = await Promise.all([route.PATCH(request("PATCH", { status: "closed" }), ctx), route.PATCH(request("PATCH", { status: "closed" }), ctx)]); for (const duplicate of duplicates) { assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).collaboration.archive.revisionId, record.archive.revisionId); }
  assert.equal((await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, collaboration.id))).length, 1);
  assert.equal((await item.PUT(request("PUT", { body: "Owner's newer Library edit", expectedRevision: 1 }), ctx)).status, 200); assert.equal((await route.PATCH(request("PATCH", { status: "closed" }), ctx)).status, 200); assert.equal((await (await item.GET(request("GET"), ctx)).json()).artifact.body, "Owner's newer Library edit");
  const original = await item.GET(new Request(`http://localhost/api/artifacts/${collaboration.id}?revision=${record.archive.revisionId}`, { headers: { host: "localhost" } }), ctx); assert.equal((await original.json()).revision.snapshot.body, archived.body);
  assert.equal((await route.DELETE(request("DELETE"), ctx)).status, 200); assert.equal((await route.GET(request("GET"), ctx)).status, 404);
  const afterDeletion = await item.GET(new Request(`http://localhost/api/artifacts/${collaboration.id}?revision=${record.archive.revisionId}`, { headers: { host: "localhost" } }), ctx); assert.equal((await afterDeletion.json()).revision.snapshot.body, archived.body);
  const long = await orchestration.createCollaboration({ goal: "Keep a large session intact", participants: [{ key: "owner", name: "Owner", kind: "human" }] });
  for (let i = 0; i < 3; i++) { const relay = await orchestration.addRelay(long.id, { target: "owner", request: "Retain every response" }); await orchestration.respondToRelay(relay.id, { response: "x".repeat(9000) + `SUFFIX ${i}` }); }
  const longCtx = { params: Promise.resolve({ id: long.id }) };
  const retained = await route.GET(new Request(`http://localhost/api/orchestrator/${long.id}?download=1`, { headers: { host: "localhost" } }), longCtx); assert.equal((await retained.json()).relays[2].response, "x".repeat(9000) + "SUFFIX 2");
  // Queue errors also cannot become successful memory-only relays.
  await fixture.pool.query(`CREATE FUNCTION fail_relay_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected relay queue failure'; END; $$; CREATE TRIGGER fail_relay_queue BEFORE INSERT ON collaboration_relays FOR EACH ROW EXECUTE FUNCTION fail_relay_queue();`);
  try { await assert.rejects(() => orchestration.addRelay(long.id, { target: "owner", request: "Never claim this was queued" })); } finally { await fixture.pool.query("DROP TRIGGER fail_relay_queue ON collaboration_relays; DROP FUNCTION fail_relay_queue();"); }
  assert.equal((await orchestration.getCollaboration(long.id)).relays.length, 3);
  const queued = await Promise.all([orchestration.addRelay(long.id, { target: "owner", request: "racing A" }), orchestration.addRelay(long.id, { target: "owner", request: "racing B" })]); assert.deepEqual(queued.map(relay => relay.seq).sort(), [4, 5]);
  for (const relay of queued) await orchestration.respondToRelay(relay.id, { response: "Acknowledged additional work" });
  const filed = await route.PATCH(request("PATCH", { status: "closed" }), longCtx); assert.equal(filed.status, 200, await filed.clone().text()); const archivedLong = (await filed.json()).collaboration; const large = (await (await item.GET(request("GET"), longCtx)).json()).artifact; assert.ok(large.contentObject.bytes > 20000); assert.ok(large.body.length < 1000); const fullDownload = await item.GET(new Request(`http://localhost/api/artifacts/${long.id}?revision=${archivedLong.archive.revisionId}&download=1`, { headers: { host: "localhost" } }), longCtx); assert.equal(fullDownload.status, 200); const fullText = await fullDownload.text(); for (let i = 0; i < 3; i++) assert.ok(fullText.includes("x".repeat(9000) + `SUFFIX ${i}`));

  const race = await orchestration.createCollaboration({ goal: "Serialise close against queue", participants: [{ key: "owner", name: "Owner", kind: "human" }] }); const raceCtx = { params: Promise.resolve({ id: race.id }) }; const queueRoute = await import("../../src/app/api/orchestrator/[id]/relays/route.ts");
  const [closing, queuing] = await Promise.all([route.PATCH(request("PATCH", { status: "closed" }), raceCtx), queueRoute.POST(request("POST", { target: "owner", request: "Do not queue into a closed snapshot" }), raceCtx)]);
  const outcome = await orchestration.getCollaboration(race.id);
  if (closing.status === 200) { assert.equal(queuing.status, 409); assert.equal(outcome.status, "closed"); assert.equal(outcome.relays.length, 0); }
  else { assert.equal(closing.status, 409); assert.equal(queuing.status, 201); assert.equal(outcome.status, "running"); assert.equal(outcome.relays.length, 1); }

});
