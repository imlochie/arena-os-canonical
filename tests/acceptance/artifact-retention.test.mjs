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
  const retry = await item.PUT(request("PUT", { body: "Owner-authorized shorter revision 🎵", title: "Explicit revision" }), params); assert.equal(retry.status, 200);
  const saved = (await (await item.GET(request("GET"), params)).json()).artifact;
  assert.equal(saved.body, "Owner-authorized shorter revision 🎵"); assert.equal(saved.title, "Explicit revision");
});
