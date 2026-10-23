/** Actual PostgreSQL row-lock and filesystem evidence for the shared desktop /
 * server WAV/MIDI boundary. Controlled bytes, not renderer/model acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../../tests/helpers/mission-postgres";
import { projects, remixSessions, remixVersions, exportJobs, exportAssets, sourceAssets } from "@/db/waveyardSchema";
import { LocalStorageProvider } from "../storage";
import { cleanupExportAttempt, exportAttemptKey, publishExport } from "../../../../waveyard-worker/packages/dsp/src/export-publication";

// No local cap: the suite declares the per-test bound once (scripts/test-source.mjs,
// 10 minutes in CI). This test builds its own PostgreSQL cluster before it does
// any work, so a fixed cap measures the runner — run 39901358509 stopped it at
// 30 s, then every later test in the file failed on the state the aborted
// transaction left behind.
test("export publication and cleanup use authoritative row locks and exact references", async t => {
  const pg = await missionPostgres(), root = await mkdtemp(join(tmpdir(), "arena-export-publication-"));
  t.after(async () => { await pg.close(); await rm(root, { recursive: true, force: true }); });
  const database = pg.database, storage = new LocalStorageProvider(join(root, "private"));
  const [project] = await database.insert(projects).values({ ownerId: randomUUID(), title: "Publication test" }).returning();
  const [session] = await database.insert(remixSessions).values({ projectId: project.id, ownerId: project.ownerId, name: "Controlled publication" }).returning();
  const [version] = await database.insert(remixVersions).values({ remixSessionId: session.id, createdById: project.ownerId, name: "Controlled bytes, not a render", snapshot: "{}" }).returning();
  const bytes = Buffer.from("controlled publication bytes"), input = join(root, "controlled"); await writeFile(input, bytes);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const job = async () => (await database.insert(exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: version.id, requestedById: project.ownerId, idempotencyKey: randomUUID() }).returning())[0];
  const object = async (id: string) => { const key = exportAttemptKey(project.id, id, "wav"); await storage.putFile(key, input); return key; };
  const write = async (tx: Parameters<Parameters<typeof database.transaction>[0]>[0], id: string, key: string) => {
    await tx.insert(exportAssets).values({ projectId: project.id, exportJobId: id, remixVersionId: version.id, storageKey: key, filename: "controlled.wav", checksumSha256: checksum, durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "controlled-not-decoded", format: "wav", fileSizeBytes: bytes.length });
    await tx.update(exportJobs).set({ status: "complete" }).where(eq(exportJobs.id, id));
  };
  await t.test("committed and cross-table references cannot be deleted", async () => {
    const row = await job(), key = await object(row.id);
    assert.equal(await publishExport(database, row.id, tx => write(tx, row.id, key)), true);
    assert.equal(await cleanupExportAttempt(database, storage, row.id, key), "referenced"); assert.equal(await storage.exists(key), true);
    const other = await job(), sourceKey = await object(other.id);
    await database.insert(sourceAssets).values({ projectId: project.id, storageKey: sourceKey, originalFilename: "controlled", mimeType: "application/octet-stream", checksumSha256: checksum, durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "controlled", fileSizeBytes: bytes.length });
    assert.equal(await cleanupExportAttempt(database, storage, other.id, sourceKey), "referenced"); assert.equal(await storage.exists(sourceKey), true);
  });
  await t.test("confirmed rollback removes only its own unreferenced output", async () => {
    const row = await job(), key = await object(row.id);
    await assert.rejects(publishExport(database, row.id, async tx => { await write(tx, row.id, key); throw new Error("controlled rollback"); }), /controlled rollback/);
    assert.equal(await cleanupExportAttempt(database, storage, row.id, key), "deleted"); assert.equal(await storage.exists(key), false);
    assert.equal((await database.select().from(exportAssets).where(eq(exportAssets.exportJobId, row.id))).length, 0);
  });
  await t.test("unknown lookup/storage outcome retains bytes until a healthy explicit reconciliation", async () => {
    const row = await job(), key = await object(row.id);
    const unavailable = { transaction: async () => { throw new Error("database unavailable"); } } as unknown as Pick<typeof database, "transaction">;
    assert.equal(await cleanupExportAttempt(unavailable, storage, row.id, key), "unknown"); assert.equal(await storage.exists(key), true);
    assert.equal(await cleanupExportAttempt(database, { delete: async () => { throw new Error("storage unavailable"); } }, row.id, key), "unknown"); assert.equal(await storage.exists(key), true);
    assert.equal(await cleanupExportAttempt(database, storage, row.id, key), "deleted");
  });
  await t.test("wrong attempt ownership and cancelled publication never touch unrelated bytes", async () => {
    const row = await job(), other = await job(), key = await object(row.id);
    assert.equal(await cleanupExportAttempt(database, storage, other.id, key), "unknown"); assert.equal(await storage.exists(key), true);
    await database.update(exportJobs).set({ status: "cancelled" }).where(eq(exportJobs.id, row.id));
    assert.equal(await publishExport(database, row.id, async () => { assert.fail("cancelled job must not publish"); }), false);
    assert.equal((await database.select().from(exportJobs).where(eq(exportJobs.id, row.id)))[0].status, "cancelled");
    assert.equal(await cleanupExportAttempt(database, storage, row.id, key), "deleted");
  });
  await t.test("competing publishers commit exactly one asset; loser cleanup preserves winner", async () => {
    const row = await job(), keys = await Promise.all([object(row.id), object(row.id)]);
    const results = await Promise.all(keys.map(key => publishExport(database, row.id, tx => write(tx, row.id, key))));
    assert.deepEqual([...results].sort(), [false, true]);
    const assets = await database.select().from(exportAssets).where(eq(exportAssets.exportJobId, row.id)); assert.equal(assets.length, 1);
    for (const key of keys) assert.equal(await cleanupExportAttempt(database, storage, row.id, key), key === assets[0].storageKey ? "referenced" : "deleted");
    assert.equal(await storage.exists(assets[0].storageKey), true);
  });
  await t.test("cleanup visibly blocks behind in-flight publication until COMMIT resolves", async () => {
    const row = await job(), key = await object(row.id), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const publishing = publishExport(database, row.id, async tx => { await write(tx, row.id, key); entered.resolve(); await release.promise; });
    await entered.promise;
    const cleanup = cleanupExportAttempt(database, storage, row.id, key);
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const blocked = await pg.pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select id, project_id from export_jobs%' limit 1");
        if (blocked.rows.length) break;
        assert.ok(Date.now() < deadline, "independent PostgreSQL observer must see cleanup waiting on the publication row lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(await storage.exists(key), true);
    } finally { release.resolve(); }
    assert.equal(await publishing, true); assert.equal(await cleanup, "referenced"); assert.equal(await storage.exists(key), true);
  });
});
