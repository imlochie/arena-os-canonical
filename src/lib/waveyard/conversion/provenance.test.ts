/** Real PostgreSQL + native FFmpeg conversion, not trained inference. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../../tests/helpers/mission-postgres";
import { encodeWav16 } from "../mixer/synth";

// No local cap: the suite declares its per-test bound once (scripts/test-source.mjs,
// 10 minutes in CI) and this test asserts nothing about duration. A 60 s cap
// fired in run 39886922288 (documentation-only commit, same code green 35
// minutes earlier) while the work measured 3.1 s on a Linux box — every run
// builds a PostgreSQL cluster (`initdb` writes 968 files / 39 MB) and drives a
// native FFmpeg probe, encode and full-decode verification per conversion, six
// of them in the corrupt-metadata repair loop, so a stalled runner can stretch
// it by an order of magnitude. The phases below are emitted as they happen, so
// a timeout that does occur names where the time went.
test("native conversion and reconversion preserve original acquisition rights and checksum lineage", async t => {
  const startedAt = Date.now();
  const phase = (name: string) => t.diagnostic(`${name} at ${Date.now() - startedAt} ms`);
  const fixture = await missionPostgres(), root = await mkdtemp(join(tmpdir(), "arena-conversion-rights-"));
  phase("postgres cluster ready");
  process.env.DATABASE_URL = fixture.url; process.env.WAVEYARD_STORAGE_DIR = join(root, "private");
  process.env.WAVEYARD_LOCAL_WORKER = "1"; delete process.env.REDIS_URL;
  const database = await import("../../../db/index");
  const schema = await import("../../../db/waveyardSchema");
  const service = await import("../library/service");
  const jobs = await import("./jobs"); const engine = await import("./engine");
  const broker = (await import("../worker-local/broker")).getLocalJobBroker();
  t.after(async () => { await broker.drain(5000); await database.pool.end(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const filename = join(root, "authorized.wav"), ownerId = randomUUID();
  await writeFile(filename, encodeWav16(Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i * .04) * .2), 44100));
  const provenance = { method: "authorized-url" as const, sourceUrl: "https://example.org/recording.wav", title: "Licensed source", artist: "Original artist", resolver: "direct-authorized-url", metadata: { attribution: "Original artist — CC BY 3.0", rightsNotice: "Attribute the author; conversion does not grant new permissions.", license: "CC-BY-3.0" } };
  const original = await service.addTrackFromAudioFile({ ownerId, filePath: filename, filename: "authorized.wav", mimeType: "audio/wav", prepareSeparation: false, provenance });
  let inputTrackId = original.track.id;
  const originalDetail = await service.getTrack(ownerId, inputTrackId);
  phase("source ingested");
  for (const format of ["flac", "aiff"] as const) {
    const [job] = await jobs.createBatch(ownerId, randomUUID(), [{ trackId: inputTrackId, tags: { title: `Converted ${format}` } }], engine.settingsSchema.parse({ format, pcmBits: 16 }));
    await jobs.execute(job.id);
    const completed = await jobs.ownedJob(ownerId, job.id); assert.equal(completed.status, "complete", completed.errorMessage ?? "");
    const m = jobs.metadata(completed); assert.equal(m.verification?.fullyDecoded, true);
    const detail = await service.getTrack(ownerId, m.outputTrackId!);
    assert.deepEqual(detail?.rights, originalDetail?.rights);
    const [acquisition] = await database.db.select().from(schema.sourceAcquisitions).where(eq(schema.sourceAcquisitions.sourceAssetId, m.outputSourceId!));
    assert.equal(acquisition.method, provenance.method); assert.equal(acquisition.sourceUrl, provenance.sourceUrl);
    const metadata = JSON.parse(acquisition.metadata);
    assert.equal(metadata.attribution, provenance.metadata.attribution);
    assert.deepEqual(metadata.conversion, { sourceAssetId: completed.sourceAssetId, sourceChecksumSha256: m.sourceChecksum, processingJobId: job.id });
    // A repeated executor invocation verifies completion, without rewriting provenance.
    await jobs.execute(job.id);
    const [again] = await database.db.select().from(schema.sourceAcquisitions).where(eq(schema.sourceAcquisitions.id, acquisition.id));
    assert.deepEqual(again, acquisition);
    inputTrackId = m.outputTrackId!;
    phase(`converted to ${format}`);
  }
  await t.test("corrupt acquisition metadata refuses library publication and repair resumes retained bytes", async () => {
    const [originalAcquisition] = await database.db.select().from(schema.sourceAcquisitions).where(eq(schema.sourceAcquisitions.sourceAssetId, originalDetail!.source.id));
    const storage = (await import("../storage")).getStorage();
    for (const invalid of ["{broken", "null", "[]"]) {
      await database.db.update(schema.sourceAcquisitions).set({ metadata: invalid }).where(eq(schema.sourceAcquisitions.id, originalAcquisition.id));
      const [job] = await jobs.createBatch(ownerId, randomUUID(), [{ trackId: original.track.id, tags: { title: `Corrupt provenance ${invalid}` } }], engine.settingsSchema.parse({ format: "flac", pcmBits: 16 }));
      await assert.rejects(jobs.execute(job.id), /provenance is malformed/);
      const failed = await jobs.ownedJob(ownerId, job.id); assert.equal(failed.status, "failed"); assert.match(failed.errorMessage!, /provenance is malformed/);
      const m = jobs.metadata(failed); assert.equal(m.outputTrackId, undefined); assert.equal(m.verification?.fullyDecoded, true);
      const before = await storage.getBuffer(m.outputKey, m.verification!.fileSizeBytes);
      await database.db.update(schema.sourceAcquisitions).set({ metadata: originalAcquisition.metadata }).where(eq(schema.sourceAcquisitions.id, originalAcquisition.id));
      await database.db.update(schema.processingJobs).set({ status: "queued" }).where(eq(schema.processingJobs.id, job.id));
      await jobs.execute(job.id);
      const resumed = await jobs.ownedJob(ownerId, job.id); assert.equal(resumed.status, "complete", resumed.errorMessage ?? "");
      assert.deepEqual(await storage.getBuffer(m.outputKey, m.verification!.fileSizeBytes), before);
      assert.deepEqual((await service.getTrack(ownerId, jobs.metadata(resumed).outputTrackId!))?.rights, originalDetail?.rights);
    }
  });
  phase("corrupt-metadata repair loop done");
  await t.test("local upload stays unknown-rights and interrupted library handoff resumes without relabelling", async () => {
    const local = await service.addTrackFromAudioFile({ ownerId: randomUUID(), filePath: filename, filename: "local.wav", mimeType: "audio/wav", prepareSeparation: false });
    const localOwner = (await database.db.select().from(schema.tracks).where(eq(schema.tracks.id, local.track.id)))[0].ownerId;
    const [job] = await jobs.createBatch(localOwner, randomUUID(), [{ trackId: local.track.id, tags: { title: "Unverified local permission" } }], engine.settingsSchema.parse({ format: "flac", pcmBits: 16 }));
    await jobs.execute(job.id);
    const m = jobs.metadata(await jobs.ownedJob(localOwner, job.id));
    const detail = await service.getTrack(localOwner, m.outputTrackId!); assert.equal(detail?.rights, null);
    const [before] = await database.db.select().from(schema.sourceAcquisitions).where(eq(schema.sourceAcquisitions.sourceAssetId, m.outputSourceId!));
    assert.equal(before.method, "local-upload"); assert.equal(before.sourceUrl, null);
    assert.equal(JSON.parse(before.metadata).conversion.sourceAssetId, job.sourceAssetId);
    // Lost acknowledgement between existing library intake and final SQL completion.
    await database.db.update(schema.processingJobs).set({ status: "queued", stage: "adding-to-library" }).where(eq(schema.processingJobs.id, job.id));
    await jobs.execute(job.id);
    const resumed = await jobs.ownedJob(localOwner, job.id); assert.equal(resumed.status, "complete", resumed.errorMessage ?? "");
    const [after] = await database.db.select().from(schema.sourceAcquisitions).where(eq(schema.sourceAcquisitions.id, before.id));
    assert.deepEqual(after, before); assert.equal(jobs.metadata(resumed).outputSourceId, m.outputSourceId);
  });
  phase("interrupted handoff resumed");
});
