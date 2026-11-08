/**
 * Arcade source workshop — real route handler, real PostgreSQL, real upstream
 * bytes (hash-pinned) and a real Chromium rule check. Nothing is mocked.
 * Skips only when the platform has no embedded-postgres package.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { bootFixture } from "../postgres-fixture.test";

const fixture = await bootFixture();
const route = fixture === null ? null : await import("./route");
if (fixture !== null) {
  after(async () => {
    try {
      const { pool } = await import("@workspace/db");
      await pool.end();
    } catch { /* pool never created */ }
    await fixture.stop();
  });
}

const post = (body: unknown) => new Request("http://127.0.0.1/api/arcade/source", {
  method: "POST",
  headers: { "content-type": "application/json", host: "127.0.0.1" },
  body: JSON.stringify(body),
});

test("source workshop: acquire, verify+save, reopen; tampered or foreign packages are refused", { timeout: 120000 }, async (t) => {
  if (fixture === null || route === null) return t.skip("embedded postgres platform package unavailable");
  const { db, artifacts } = await import("@workspace/db");

  const rejected = await route.POST(post({ adapter: "2048", initialTiles: 99 }));
  assert.equal(rejected.status, 400);
  assert.equal((await route.POST(post({ adapter: "2048", initialTiles: 3, spawnRule: "bogus" }))).status, 400);

  const generated = await route.POST(post({ adapter: "2048", initialTiles: 3, spawnRule: "guaranteed-four", generateOnly: true }));
  const generatedBody: any = await generated.json();
  assert.equal(generated.status, 200, generatedBody.error);
  assert.equal(generatedBody.artifactId, undefined, "generateOnly must not persist");
  assert.equal(generatedBody.bundle.modification.spawnRule, "guaranteed-four");

  const saved = await route.POST(post({ action: "save", bundle: generatedBody.bundle }));
  const savedBody: any = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.runtime.status, "passed");
  assert.ok(savedBody.artifactId);

  const reopened = await route.POST(post({ action: "reopen", artifactId: savedBody.artifactId }));
  const reopenedBody: any = await reopened.json();
  assert.equal(reopened.status, 200, JSON.stringify(reopenedBody));
  assert.equal(reopenedBody.bundle.modification.modifiedSha256, savedBody.bundle.modification.modifiedSha256);
  assert.equal(reopenedBody.runtime.status, "passed");
  assert.match(reopenedBody.preview, /Content-Security-Policy/);

  // A client-supplied bundle with an edited modification is never saved.
  const forged = structuredClone(generatedBody.bundle);
  forged.modification.content = forged.modification.content.replace("var value = 4;", "var value = 8;");
  const before = (await db.select().from(artifacts).where(eq(artifacts.sourceType, "arcade-source"))).length;
  assert.equal((await route.POST(post({ action: "save", bundle: forged }))).status, 422);
  assert.equal((await db.select().from(artifacts).where(eq(artifacts.sourceType, "arcade-source"))).length, before);

  // An edited saved artifact is rejected on reopen rather than trusted.
  const row = (await db.select().from(artifacts).where(eq(artifacts.id, savedBody.artifactId)))[0];
  const edited = JSON.parse(row.body);
  edited.modification.content += "\n// edited after save";
  await db.update(artifacts).set({ body: JSON.stringify(edited) }).where(eq(artifacts.id, savedBody.artifactId));
  assert.equal((await route.POST(post({ action: "reopen", artifactId: savedBody.artifactId }))).status, 422);

  // Another owner's, or a non-source, artifact is indistinguishable from absent.
  await db.update(artifacts).set({ body: row.body, ownerId: "someone-else" }).where(eq(artifacts.id, savedBody.artifactId));
  assert.equal((await route.POST(post({ action: "reopen", artifactId: savedBody.artifactId }))).status, 404);
  assert.equal((await route.POST(post({ action: "reopen", artifactId: "not-a-uuid" }))).status, 400);
});
