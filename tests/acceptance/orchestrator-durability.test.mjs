// Actual Orchestrator HTTP handlers and native PostgreSQL write boundaries.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let fixture, pool, collection, item, responseRoute, advanceRoute, resultRoute, storageRoot, adapter, endpoint;
let executions = 0, adapterMode = "reply", observedRequest, releaseAdapter, adapterObserved;
const fullResult = "RETAINED REAL HTTP ADAPTER OUTPUT 🎵\n".repeat(1000) + "IMPORTANT FULL RESULT SUFFIX";
function req(method = "GET", body) { return new Request("http://localhost/api/orchestrator", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
function context(id) { return { params: Promise.resolve({ id, relayId: id }) }; }
const input = { goal: "Retain real work, never invent an acknowledged session", participants: [{ key: "reviewer", name: "Owner", kind: "human" }], relay: { target: "reviewer", request: "Review the retained work", classification: "private" } };
before(async () => { storageRoot = await mkdtemp(path.join(tmpdir(), "arena-orchestrator-receipts-")); process.env.WAVEYARD_STORAGE_DIR = storageRoot;
  adapter = createServer(async (request, response) => { let body = ""; for await (const chunk of request) body += chunk; observedRequest = JSON.parse(body); executions++; adapterObserved?.(); if (adapterMode === "disconnect") { response.destroy(); return; } if (adapterMode === "hold") await new Promise(resolve => { releaseAdapter = resolve; }); response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify({ choices: [{ message: { content: fullResult } }] })); }); await new Promise(resolve => adapter.listen(0, "127.0.0.1", resolve)); endpoint = `http://127.0.0.1:${adapter.address().port}`;
  fixture = await missionPostgres(); process.env.DATABASE_URL = fixture.url; collection = await import("../../src/app/api/orchestrator/route.ts"); item = await import("../../src/app/api/orchestrator/[id]/route.ts"); responseRoute = await import("../../src/app/api/orchestrator/relays/[relayId]/route.ts"); advanceRoute = await import("../../src/app/api/orchestrator/[id]/advance/route.ts"); resultRoute = await import("../../src/app/api/orchestrator/relays/[relayId]/result/route.ts"); pool = (await import("../../src/db/index.ts")).pool; await pool.query("CREATE FUNCTION reject_orchestrator_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected orchestrator write failure'; END $$"); });
after(async () => { await pool?.end(); await fixture?.close(); if (adapter) await new Promise(resolve => adapter.close(resolve)); if (storageRoot) await rm(storageRoot, { recursive: true, force: true }); });
async function fail(table, operation, work) { await pool.query(`CREATE TRIGGER reject_write BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_orchestrator_write()`); try { await work(); } finally { await pool.query(`DROP TRIGGER reject_write ON ${table}`); } }
async function counts() { return (await pool.query("SELECT (SELECT count(*) FROM collaborations) parents, (SELECT count(*) FROM collaboration_participants) participants, (SELECT count(*) FROM collaboration_relays) relays")).rows[0]; }
async function create() { const response = await collection.POST(req("POST", input)); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).collaboration; }
test("failed participant/initial-relay writes never acknowledge memory-only or partial creations", async () => {
  for (const table of ["collaborations", "collaboration_participants", "collaboration_relays"]) { const before = await counts(); await fail(table, "INSERT", async () => { const response = await collection.POST(req("POST", table === "collaborations" ? { ...input, relay: null } : input)); assert.equal(response.status, 503, await response.clone().text()); }); assert.deepEqual(await counts(), before); }
  const created = await create(); assert.equal(created.participants.length, 1); assert.equal(created.relays.length, 1);
});
test("read outage is unavailable, not an empty list or cached/fabricated session; reconnection restores durable data", async () => {
  const created = await create(); await fixture.stop();
  try { assert.equal((await collection.GET(req())).status, 503); assert.equal((await item.GET(req(), context(created.id))).status, 503); } finally { await fixture.start(); }
  assert.equal((await (await item.GET(req(), context(created.id))).json()).collaboration.relays[0].id, created.relays[0].id);
});
test("human response and parent status commit together, preserve pending work on either write failure, and retries do not overwrite an acknowledged answer", async () => {
  const created = await create(); const relay = created.relays[0];
  for (const table of ["collaboration_relays", "collaborations"]) { await fail(table, "UPDATE", async () => { const response = await responseRoute.POST(req("POST", { response: "AUTHORITATIVE OWNER ANSWER 🎵" }), context(relay.id)); assert.equal(response.status, 503); }); const read = (await (await item.GET(req(), context(created.id))).json()).collaboration; assert.equal(read.relays[0].status, "pending"); assert.equal(read.relays[0].response, null); }
  const answered = await responseRoute.POST(req("POST", { response: "AUTHORITATIVE OWNER ANSWER 🎵" }), context(relay.id)); assert.equal(answered.status, 200); const retry = await responseRoute.POST(req("POST", { response: "MUST NOT OVERWRITE" }), context(relay.id)); assert.equal(retry.status, 409); const acknowledged = await responseRoute.POST(req("POST", { response: "AUTHORITATIVE OWNER ANSWER 🎵" }), context(relay.id)); assert.equal((await acknowledged.json()).relay.response, "AUTHORITATIVE OWNER ANSWER 🎵");
});
test("delete rolls back every dependent write boundary and a confirmed deletion survives SQL restart", async () => {
  const created = await create();
  for (const table of ["collaboration_relays", "collaboration_participants", "collaborations"]) { const before = await counts(); await fail(table, "DELETE", async () => { assert.equal((await item.DELETE(req("DELETE"), context(created.id))).status, 503); }); assert.deepEqual(await counts(), before); const retained = (await (await item.GET(req(), context(created.id))).json()).collaboration; assert.equal(retained.relays[0].id, created.relays[0].id); assert.equal(retained.participants.length, 1); }
  assert.equal((await item.DELETE(req("DELETE"), context(created.id))).status, 200); await fixture.stop(); await fixture.start(); assert.equal((await item.GET(req(), context(created.id))).status, 404);
});

async function external() { const response = await collection.POST(req("POST", { goal: "Execute this request once; preserve the complete real HTTP output", participants: [{ name: "Controlled adapter", key: "adapter", kind: "external", adapterUrl: endpoint }], relay: { target: "adapter", classification: "public", request: "x".repeat(7980) + "END-OF-REQUEST" } })); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).collaboration; }
async function advance(id) { return advanceRoute.POST(req("POST", { localOnly: true }), context(id)); }
async function restartApplicationAdvance(id) {
  const code = `const {POST}=await import('./src/app/api/orchestrator/[id]/advance/route.ts'); const r=await POST(new Request('http://localhost/api/orchestrator',{method:'POST',headers:{host:'localhost','content-type':'application/json'},body:JSON.stringify({localOnly:true})}),{params:Promise.resolve({id:${JSON.stringify(id)}})}); console.log(JSON.stringify({status:r.status,data:await r.json()})); await (await import('./src/db/index.ts')).pool.end();`;
  const child = spawn(process.execPath, ["--import", "./scripts/register-src-loader.mjs", "--input-type=module", "--eval", code], { cwd: process.cwd(), env: { ...process.env }, timeout: 15000 }); let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk); const exit = await new Promise(resolve => child.once("exit", resolve)); assert.equal(exit, 0, stderr); return JSON.parse(stdout.trim());
}
test("stable creation keys survive concurrent retries without duplicate parents/participants/initial relays and reject changed work", async () => {
  const requestId = randomUUID(); const before = await counts(); const responses = await Promise.all([collection.POST(req("POST", { ...input, requestId })), collection.POST(req("POST", { ...input, requestId }))]); assert.deepEqual(responses.map(response => response.status), [201, 201]); const sessions = await Promise.all(responses.map(response => response.json())); assert.equal(sessions[0].collaboration.id, requestId); assert.equal(sessions[1].collaboration.relays[0].id, sessions[0].collaboration.relays[0].id); const after = await counts(); for (const key of Object.keys(before)) assert.equal(Number(after[key]), Number(before[key]) + 1); assert.equal((await collection.POST(req("POST", { ...input, requestId, goal: "DIFFERENT WORK MUST NOT OVERWRITE" }))).status, 409);
});
test("a failed durable claim sends nothing; concurrent Advance calls execute one HTTP request and download its full Unicode result", async () => {
  const created = await external(); const before = executions;
  await fail("collaboration_relays", "UPDATE", async () => { assert.equal((await advance(created.id)).status, 503); }); assert.equal(executions, before);
  adapterMode = "hold"; const observed = new Promise(resolve => adapterObserved = resolve); const first = advance(created.id); await observed; adapterObserved = null;
  try { const second = await advance(created.id); assert.equal(second.status, 200); assert.equal((await second.json()).ran, "blocked-relay"); assert.equal(executions, before + 1); } finally { releaseAdapter(); adapterMode = "reply"; }
  const response = await first; assert.equal(response.status, 200, await response.clone().text()); const finished = (await response.json()).collaboration.relays[0]; assert.equal(finished.status, "responded"); assert.match(finished.note, /Preview/); assert.ok(finished.resultReceipt); assert.match(observedRequest.messages[1].content, /END-OF-REQUEST/); const download = await resultRoute.GET(req(), context(finished.id)); assert.equal(download.status, 200); assert.equal(await download.text(), fullResult);
});
test("post-execution relay/parent SQL failures retain the full result across SQL and application restart; recovery never replays the adapter", async () => {
  for (const table of ["collaboration_relays", "collaborations"]) {
    const created = await external(); const before = executions;
    await pool.query(`CREATE TRIGGER reject_write BEFORE UPDATE ON ${table} FOR EACH ROW ${table === "collaboration_relays" ? "WHEN (NEW.status = 'responded')" : ""} EXECUTE FUNCTION reject_orchestrator_write()`);
    try { const response = await advance(created.id); assert.equal(response.status, 503, await response.clone().text()); } finally { await pool.query(`DROP TRIGGER reject_write ON ${table}`); }
    assert.equal(executions, before + 1); const [claimed] = (await pool.query("SELECT status,result_receipt FROM collaboration_relays WHERE id=$1", [created.relays[0].id])).rows; assert.equal(claimed.status, "dispatching"); assert.equal(claimed.result_receipt, null);
    assert.equal(await (await resultRoute.GET(req(), context(created.relays[0].id))).text(), fullResult);
    await fixture.stop(); await fixture.start(); const recovered = await restartApplicationAdvance(created.id); assert.equal(recovered.status, 200, JSON.stringify(recovered)); assert.equal(recovered.data.collaboration.relays[0].status, "responded"); assert.match(recovered.data.note, /without replaying/); assert.equal(executions, before + 1);
  }
});
test("uncertain external effects are durable, never automatically replayed, and require an explicit owner cancellation before removal", async () => {
  const created = await external(); const before = executions; adapterMode = "disconnect"; let response; try { response = await advance(created.id); } finally { adapterMode = "reply"; } assert.equal(response.status, 200); assert.equal((await response.json()).collaboration.relays[0].status, "uncertain"); assert.equal(executions, before + 1);
  assert.equal((await advance(created.id)).status, 200); assert.equal(executions, before + 1); assert.equal((await item.DELETE(req("DELETE"), context(created.id))).status, 409); assert.equal((await item.PATCH(req("PATCH", { status: "closed" }), context(created.id))).status, 409);
  assert.equal((await responseRoute.POST(req("POST", { rejected: true }), context(created.relays[0].id))).status, 200); assert.equal((await item.DELETE(req("DELETE"), context(created.id))).status, 200); assert.equal(executions, before + 1);
});

test("relay request keys acknowledge the same durable identity on concurrent retries, reject changed work and survive restart", async () => {
  const created = await create(); const queue = await import("../../src/app/api/orchestrator/[id]/relays/route.ts"); const requestId = randomUUID(); const input = { requestId, target: "reviewer", request: "One stable additional checkpoint" };
  const results = await Promise.all([queue.POST(req("POST", input), context(created.id)), queue.POST(req("POST", input), context(created.id))]); for (const response of results) { assert.equal(response.status, 201, await response.clone().text()); assert.equal((await response.json()).relay.id, requestId); } assert.equal((await pool.query("SELECT count(*) FROM collaboration_relays WHERE collaboration_id=$1", [created.id])).rows[0].count, "2");
  assert.equal((await queue.POST(req("POST", { ...input, request: "Must not overwrite the first intent" }), context(created.id))).status, 409); await fixture.stop(); await fixture.start(); assert.equal((await (await queue.POST(req("POST", input), context(created.id))).json()).relay.id, requestId);
});
test("failed synthesis insertion rolls back an entire actual deliberation batch, with no hidden partial round", async () => {
  const response = await collection.POST(req("POST", { goal: "Transactional deliberation", participants: [{ key: "a", name: "A", kind: "model" }, { key: "b", name: "B", kind: "model" }] })); const created = (await response.json()).collaboration; const route = await import("../../src/app/api/orchestrator/[id]/deliberate/route.ts");
  await pool.query("CREATE TRIGGER reject_write BEFORE INSERT ON collaboration_relays FOR EACH ROW WHEN (NEW.purpose='synthesis') EXECUTE FUNCTION reject_orchestrator_write()"); try { assert.equal((await route.POST(req("POST"), context(created.id))).status, 503); } finally { await pool.query("DROP TRIGGER reject_write ON collaboration_relays"); }
  assert.equal((await pool.query("SELECT count(*) FROM collaboration_relays WHERE collaboration_id=$1", [created.id])).rows[0].count, "0"); const retry = await route.POST(req("POST"), context(created.id)); assert.equal(retry.status, 200); assert.deepEqual((await retry.json()).collaboration.relays.map(relay => relay.seq), [1, 2, 3]);
});
