/** Delivery integration: actual PG/HTTP handlers/storage/ZIP, seeded publication
 * receipts plus native source-copy fault regressions. Not model evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../tests/helpers/mission-postgres";
import { encodeWav16 } from "./mixer/synth";

test("Studio downloads automatically bundle exact media, frozen source notices and honest unknowns", { timeout: 60000 }, async t => {
  const fixture = await missionPostgres(), root = await mkdtemp(join(tmpdir(), "arena-export-bundle-"));
  process.env.DATABASE_URL = fixture.url; process.env.WAVEYARD_STORAGE_DIR = join(root, "private");
  process.env.WAVEYARD_LOCAL_WORKER = "1"; delete process.env.REDIS_URL;
  const database = await import("../../db/index"), schema = await import("../../db/waveyardSchema");
  const service = await import("./library/service"), context = await import("./local-context");
  const broker = (await import("./worker-local/broker")).getLocalJobBroker();
  t.after(async () => { await broker.drain(5000); await database.pool.end(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const storage = (await import("./storage")).getStorage();
  const media = encodeWav16(Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i * .04) * .2), 44100);
  const input = join(root, "source.wav"); await writeFile(input, media);
  const attribution = "Original artist — CC BY 3.0", rightsNotice = "Attribute the author; conversion does not grant permission.";
  const added = await service.addTrackFromAudioFile({ ownerId: context.LOCAL_OWNER_ID, filePath: input, filename: "licensed.wav", mimeType: "audio/wav", prepareSeparation: false, provenance: { method: "authorized-url", sourceUrl: "https://user:secret@example.org/music.wav?token=secret#private", title: "Licensed source", artist: "Original artist", metadata: { attribution, rightsNotice, privateDebugPath: "/private/not-for-export" } } });
  const source = (await service.getTrack(context.LOCAL_OWNER_ID, added.track.id))!.source;
  const [sourceRow] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, source.id));
  await database.db.insert(schema.processingJobs).values({ projectId: sourceRow.projectId, sourceAssetId: source.id, type: "separation", model: "none", requestedDevice: "cpu", status: "failed", errorCode: "queue_unavailable", idempotencyKey: randomUUID() });
  const bridge = await import("../../app/api/stems/passthrough/route");
  const bridged = await bridge.POST(new Request("http://arena/api/stems/passthrough", { method: "POST", body: JSON.stringify({ sourceAssetId: source.id }) }));
  assert.equal(bridged.status, 201); const { stem } = await bridged.json();
  const [project] = await database.db.insert(schema.projects).values({ ownerId: context.LOCAL_OWNER_ID, title: "Studio reference" }).returning();
  const [session] = await database.db.insert(schema.remixSessions).values({ projectId: project.id, ownerId: context.LOCAL_OWNER_ID, name: "Saved edit" }).returning();
  const [track] = await database.db.insert(schema.remixTracks).values({ remixSessionId: session.id, stemAssetId: stem.id, name: "Source", sortOrder: 0 }).returning();
  await database.db.insert(schema.remixClips).values({ remixTrackId: track.id, stemAssetId: stem.id, timelineStartMs: 0, sourceOffsetMs: 0, durationMs: 1000 });
  const versions = await import("../../app/api/remixes/[id]/versions/route");
  const saved = await versions.POST(new Request("http://arena/api/remixes/versions", { method: "POST", body: JSON.stringify({ name: "Frozen licensed edit" }) }), { params: Promise.resolve({ id: session.id }) });
  assert.equal(saved.status, 201); const versionId = (await saved.json()).version.id;
  const [job] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, status: "complete", stage: "complete", idempotencyKey: randomUUID() }).returning();
  const key = `projects/${project.id}/export/${randomUUID()}.wav`; await storage.putFile(key, input, "audio/wav");
  const [asset] = await database.db.insert(schema.exportAssets).values({ projectId: project.id, exportJobId: job.id, remixVersionId: versionId, storageKey: key, filename: "controlled.wav", checksumSha256: createHash("sha256").update(media).digest("hex"), durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: media.length }).returning();
  const route = await import("../../app/api/exports/[id]/media/route");
  const request = () => route.GET(new Request(`http://arena/api/exports/${job.id}/media?download=1`), { params: Promise.resolve({ id: job.id }) });
  const response = await request();
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/zip");
  const unzip = async (response: Response, name: string) => {
    const path = join(root, `${name}.zip`), extracted = join(root, name); await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const names = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist())); z.extractall(sys.argv[2])", path, extracted], { encoding: "utf8" }));
    assert.deepEqual(names, ["export.wav", "RIGHTS.txt", "export-manifest.json"]);
    assert.deepEqual(await readFile(join(extracted, "export.wav")), Buffer.from(media));
    const notice = await readFile(join(extracted, "RIGHTS.txt"), "utf8"), manifest = JSON.parse(await readFile(join(extracted, "export-manifest.json"), "utf8"));
    assert.equal(manifest.media.sha256, asset.checksumSha256); assert.equal(manifest.remixVersionId, versionId);
    const portable = JSON.stringify(manifest) + notice;
    assert.ok(!portable.includes("secret")); assert.ok(!portable.includes("/private/")); assert.ok(!portable.includes(key));
    return { notice, manifest };
  };
  const first = await unzip(response, "first"); assert.ok(first.notice.includes(attribution)); assert.ok(first.notice.includes(rightsNotice));
  assert.equal(first.manifest.attribution.basis, "saved-version");
  await database.db.update(schema.sourceAcquisitions).set({ metadata: "{}" }).where(eq(schema.sourceAcquisitions.sourceAssetId, source.id));
  const frozen = await unzip(await request(), "frozen"); assert.equal(frozen.notice, first.notice);
  const [version] = await database.db.select().from(schema.remixVersions).where(eq(schema.remixVersions.id, versionId));
  const snapshot = JSON.parse(version.snapshot); delete snapshot.sourceAttribution;
  await database.db.update(schema.remixVersions).set({ snapshot: JSON.stringify(snapshot) }).where(eq(schema.remixVersions.id, versionId));
  const legacy = await unzip(await request(), "legacy");
  assert.equal(legacy.manifest.attribution.basis, "legacy-current-acquisition"); assert.match(legacy.notice, /unknown/i);
  await t.test("invalid or incomplete frozen notices never silently become legacy notices", async () => {
    for (const invalid of [{}, { ...JSON.parse(version.snapshot).sourceAttribution, sources: [] }]) {
      await database.db.update(schema.remixVersions).set({ snapshot: JSON.stringify({ ...snapshot, sourceAttribution: invalid }) }).where(eq(schema.remixVersions.id, versionId));
      assert.equal((await request()).status, 422);
    }
    await database.db.update(schema.remixVersions).set({ snapshot: JSON.stringify(snapshot) }).where(eq(schema.remixVersions.id, versionId));
  });
  await t.test("new snapshots and legacy downloads refuse another owner's referenced source", async () => {
    await database.db.update(schema.projects).set({ ownerId: randomUUID() }).where(eq(schema.projects.id, sourceRow.projectId));
    const refused = await versions.POST(new Request("http://arena/api/remixes/versions", { method: "POST", body: JSON.stringify({ name: "Foreign reference" }) }), { params: Promise.resolve({ id: session.id }) });
    assert.equal(refused.status, 403); assert.equal((await request()).status, 403);
    await database.db.update(schema.projects).set({ ownerId: context.LOCAL_OWNER_ID }).where(eq(schema.projects.id, sourceRow.projectId));
  });
  await t.test("MIDI bundle includes its checksum-pinned analysis source even outside the arrangement", async () => {
    const midiSourcePath = join(root, "midi-source.wav");
    await writeFile(midiSourcePath, encodeWav16(Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i * .06) * .2), 44100));
    const extra = await service.addTrackFromAudioFile({ ownerId: context.LOCAL_OWNER_ID, filePath: midiSourcePath, filename: "midi-source.wav", mimeType: "audio/wav", prepareSeparation: false });
    const sourceId = (await service.getTrack(context.LOCAL_OWNER_ID, extra.track.id))!.source.id;
    const [midiSource] = await database.db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, sourceId));
    const [midiJob] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, status: "complete", stage: "complete", idempotencyKey: randomUUID(), format: "midi", midiSourceAssetId: sourceId, midiSourceChecksumSha256: midiSource.checksumSha256 }).returning();
    const midi = Buffer.from("4d546864000000060000000101e04d54726b0000000400ff2f00", "hex"), midiPath = join(root, "output.mid");
    await writeFile(midiPath, midi); const midiKey = `projects/${project.id}/export/${randomUUID()}.mid`; await storage.putFile(midiKey, midiPath, "audio/midi");
    await database.db.insert(schema.exportAssets).values({ projectId: project.id, exportJobId: midiJob.id, remixVersionId: versionId, storageKey: midiKey, filename: "controlled.mid", checksumSha256: createHash("sha256").update(midi).digest("hex"), durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "midi", format: "midi", fileSizeBytes: midi.length });
    const response = await route.GET(new Request(`http://arena/api/exports/${midiJob.id}/media?download=1`), { params: Promise.resolve({ id: midiJob.id }) });
    assert.equal(response.status, 200); const path = join(root, "midi.zip"), extracted = join(root, "midi"); await writeFile(path, Buffer.from(await response.arrayBuffer()));
    execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.namelist()==['export.mid','RIGHTS.txt','export-manifest.json']; z.extractall(sys.argv[2])", path, extracted]);
    assert.deepEqual(await readFile(join(extracted, "export.mid")), midi);
    const manifest = JSON.parse(await readFile(join(extracted, "export-manifest.json"), "utf8"));
    assert.equal(manifest.midiAnalysisSource.basis, "midi-analysis-current-acquisition");
    assert.equal(manifest.midiAnalysisSource.sources[0].sourceAssetId, sourceId); assert.equal(manifest.midiAnalysisSource.sources[0].sourceChecksumSha256, midiSource.checksumSha256);
    await database.db.update(schema.exportJobs).set({ midiSourceChecksumSha256: "0".repeat(64) }).where(eq(schema.exportJobs.id, midiJob.id));
    assert.equal((await route.GET(new Request(`http://arena/api/exports/${midiJob.id}/media?download=1`), { params: Promise.resolve({ id: midiJob.id }) })).status, 422);
    assert.equal(await storage.exists(midiKey), true);
  });
  await t.test("native export lost COMMIT acknowledgement never deletes already-published audio", async () => {
    const [attempt] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, idempotencyKey: randomUUID() }).returning();
    const handle = (await import("./worker-local/export")).handleExportJob;
    const transaction = database.db.transaction.bind(database.db);
    database.db.transaction = async (...args) => { await transaction(...args); throw new Error("controlled export lost COMMIT acknowledgement"); };
    try {
      await assert.rejects(handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" }), /lost COMMIT acknowledgement/);
    } finally { database.db.transaction = transaction; }
    const [finished] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, attempt.id));
    const [published] = await database.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, attempt.id));
    assert.equal(finished.status, "complete"); assert.ok(published);
    assert.equal(await storage.exists(published.storageKey), true, "an acknowledged asset row must retain its actual audio");
    const bytes = await storage.getBuffer(published.storageKey, published.fileSizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), published.checksumSha256);
    await handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" });
    const [again] = await database.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, attempt.id)); assert.deepEqual(again, published);
  });
  await t.test("native export cancelled after upload cannot publish or resurrect the job", async () => {
    const [attempt] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, idempotencyKey: randomUUID() }).returning();
    const handle = (await import("./worker-local/export")).handleExportJob, put = storage.putFile.bind(storage), keys: string[] = [];
    storage.putFile = async (...args) => { await put(...args); keys.push(args[0]); await database.db.update(schema.exportJobs).set({ status: "cancelled", stage: "cancelled" }).where(eq(schema.exportJobs.id, attempt.id)); };
    try { await handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" }); }
    finally { storage.putFile = put; }
    assert.equal((await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, attempt.id)))[0].status, "cancelled");
    assert.equal((await database.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, attempt.id))).length, 0);
    assert.equal(keys.length, 1); assert.equal(await storage.exists(keys[0]), false);
  });
  await t.test("native export uncertain publication retains job-scoped bytes until explicit healthy reconciliation", async () => {
    const [attempt] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, idempotencyKey: randomUUID() }).returning();
    const handle = (await import("./worker-local/export")).handleExportJob, transaction = database.db.transaction.bind(database.db), put = storage.putFile.bind(storage), keys: string[] = [];
    database.db.transaction = async () => { throw new Error("controlled publication database unavailable"); };
    storage.putFile = async (...args) => { keys.push(args[0]); await put(...args); };
    try { await assert.rejects(handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" }), /database unavailable/); }
    finally { database.db.transaction = transaction; storage.putFile = put; }
    const [failed] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, attempt.id));
    assert.equal(failed.status, "failed"); assert.equal(failed.stage, "reconciliation_required"); assert.equal(failed.errorCode, "publication_unknown");
    assert.equal(keys.length, 1); assert.ok(keys[0].includes(`/export/${attempt.id}/`)); assert.equal(await storage.exists(keys[0]), true);
    const { cleanupExportAttempt } = await import("../../../waveyard-worker/packages/dsp/src/export-publication");
    assert.equal(await cleanupExportAttempt(database.db, storage, attempt.id, keys[0]), "deleted"); assert.equal(await storage.exists(keys[0]), false);
  });
  await t.test("native render refuses changed source bytes and corrupt copies before minting an export", async t => {
    const handle = (await import("./worker-local/export")).handleExportJob;
    const original = Buffer.from(media), corrupted = Buffer.from(media); corrupted[100] ^= 1;
    const filename = storage.getLocalPath(sourceRow.storageKey)!;
    const copy = storage.getToFile.bind(storage);
    for (const fault of ["stored-bytes", "copied-bytes", "copy-unavailable"]) await t.test(fault, async () => {
      const [attempt] = await database.db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, requestedById: context.LOCAL_OWNER_ID, idempotencyKey: randomUUID() }).returning();
      if (fault === "stored-bytes") await writeFile(filename, corrupted);
      else storage.getToFile = async (...args) => { await copy(...args); if (args[0] === sourceRow.storageKey) { if (fault === "copy-unavailable") await rm(args[1]); else await writeFile(args[1], corrupted); } };
      try {
        await assert.rejects(handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" }), /identity|checksum/i);
        const [failed] = await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, attempt.id));
        assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "source_identity_unverified");
        assert.equal((await database.db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId, attempt.id))).length, 0);
      } finally { storage.getToFile = copy; await writeFile(filename, original); }
      // Repair permits the SAME request/version to render; no substitute source.
      await handle({ exportJobId: attempt.id, projectId: project.id, remixSessionId: session.id, remixVersionId: versionId, format: "wav" });
      assert.equal((await database.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, attempt.id)))[0].status, "complete");
    });
  });
  await t.test("private source, stem and export seek requests deliver exact suffix/clamped bytes", async t => {
    const assets = await import("../../app/api/assets/[id]/route");
    const release = await import("../../app/api/public/projects/[id]/release/route");
    await database.db.update(schema.projects).set({ visibility: "public", publicationStatus: "published", moderationStatus: "active", publishedExportAssetId: asset.id }).where(eq(schema.projects.id, project.id));
    for (const [label, handler, id] of [
      ["source", assets.GET, source.id], ["stem", assets.GET, stem.id], ["export", route.GET, job.id], ["public", release.GET, project.id],
    ] as const) {
      for (const [range, start, end] of [
        ["bytes=-100", media.length - 100, media.length - 1],
        ["bytes=100-", 100, media.length - 1],
        [`bytes=100-${media.length + 999}`, 100, media.length - 1],
        ["bytes=-99999999999999999999999999", 0, media.length - 1],
        ["BYTES=1-2", 1, 2],
      ] as const) await t.test(`${label}: ${range}`, async () => {
        const response = await handler(new Request("http://arena/media", { headers: { Range: range } }), { params: Promise.resolve({ id }) });
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${media.length}`);
        assert.equal(response.headers.get("content-length"), String(end - start + 1));
        assert.deepEqual(bytes, Buffer.from(media).subarray(start, end + 1));
      });
      for (const range of ["bytes=-0", `bytes=${media.length}-`, "bytes=2-1", "bytes=0-1,2-3", "bytes=-"]) await t.test(`${label}: invalid ${range}`, async () => {
        const response = await handler(new Request("http://arena/media", { headers: { Range: range } }), { params: Promise.resolve({ id }) });
        assert.equal(response.status, 416);
        assert.equal(response.headers.get("content-range"), `bytes */${media.length}`);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      });
    }
  });
  await t.test("Unicode source and release downloads preserve the filename and exact bytes", async t => {
    const name = "夜の演奏 🎵.wav";
    await database.db.update(schema.sourceAssets).set({ originalFilename: name }).where(eq(schema.sourceAssets.id, source.id));
    await database.db.update(schema.exportAssets).set({ filename: name }).where(eq(schema.exportAssets.id, asset.id));
    const assets = await import("../../app/api/assets/[id]/route");
    const release = await import("../../app/api/public/projects/[id]/release/route");
    await database.db.update(schema.projects).set({ downloadPermission: "public" }).where(eq(schema.projects.id, project.id));
    for (const [label, handler, id] of [["source", assets.GET, source.id], ["public", release.GET, project.id]] as const) {
      for (const range of [undefined, "bytes=-100"]) await t.test(`${label} ${range ?? "full"}`, async () => {
        const response = await handler(new Request("http://arena/media?download=1", { headers: range ? { Range: range } : {} }), { params: Promise.resolve({ id }) });
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.status, range ? 206 : 200);
        const disposition = response.headers.get("content-disposition") ?? "";
        assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
        assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
        assert.deepEqual(bytes, range ? Buffer.from(media).subarray(-100) : Buffer.from(media));
      });
    }
  });
  // Streaming/preview is still the original WAV, not a ZIP or a re-render.
  const raw = await route.GET(new Request(`http://arena/api/exports/${job.id}/media`), { params: Promise.resolve({ id: job.id }) });
  assert.equal(raw.headers.get("content-type"), "audio/wav"); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from(media));
  // A checksum failure does not yield a partial bundle or remove published audio.
  await storage.putFile(key, input, "audio/wav");
  await database.db.update(schema.exportAssets).set({ checksumSha256: "0".repeat(64) }).where(eq(schema.exportAssets.id, asset.id));
  assert.equal((await request()).status, 422); assert.equal(await storage.exists(key), true);
});
