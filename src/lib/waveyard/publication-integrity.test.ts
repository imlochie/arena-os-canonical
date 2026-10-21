/** Real PG + local files + production publication/release handlers. Seeded export
 * rows are deliberate corrupt-storage fault fixtures, not native render proof. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../tests/helpers/mission-postgres";
import { encodeWav16 } from "./mixer/synth";

test("public publication and playback never certify absent, changed or unreadable export bytes", { timeout: 60000 }, async t => {
  const fixture = await missionPostgres();
  const root = await mkdtemp(join(tmpdir(), "arena-public-integrity-"));
  process.env.DATABASE_URL = fixture.url; process.env.WAVEYARD_STORAGE_DIR = root;
  const { db, pool } = await import("../../db/index");
  const schema = await import("../../db/waveyardSchema");
  const { LOCAL_OWNER_ID } = await import("./local-context");
  const storage = (await import("./storage")).getStorage();
  const publication = await import("../../app/api/waveyard/projects/[id]/publication/route");
  const release = await import("../../app/api/public/projects/[id]/release/route");
  t.after(async () => { await pool.end(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const media = Buffer.from(encodeWav16(Float32Array.from({ length: 88200 }, (_, i) => Math.sin(i * .04) * .2), 44100));
  const input = join(root, "input.wav"); await writeFile(input, media);
  const [project] = await db.insert(schema.projects).values({ ownerId: LOCAL_OWNER_ID, title: "Publication fault probe" }).returning();
  const [session] = await db.insert(schema.remixSessions).values({ projectId: project.id, ownerId: LOCAL_OWNER_ID, name: "Fault fixture" }).returning();
  const [version] = await db.insert(schema.remixVersions).values({ remixSessionId: session.id, name: "Fault fixture", snapshot: "{}", createdById: LOCAL_OWNER_ID }).returning();
  const [job] = await db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: version.id, requestedById: LOCAL_OWNER_ID, status: "complete", stage: "complete", idempotencyKey: randomUUID() }).returning();
  const key = `projects/${project.id}/export/${randomUUID()}.wav`;
  await storage.putFile(key, input);
  const [asset] = await db.insert(schema.exportAssets).values({ projectId: project.id, exportJobId: job.id, remixVersionId: version.id, storageKey: key, filename: "release.wav", checksumSha256: createHash("sha256").update(media).digest("hex"), durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: media.length }).returning();
  const params = { params: Promise.resolve({ id: project.id }) };
  const publish = () => publication.PUT(new Request("http://arena/publication", { method: "PUT", body: JSON.stringify({ visibility: "public", rightsAcknowledged: true, licenseCode: "all-rights-reserved", publishedExportAssetId: asset.id, downloadPermission: "public" }) }), params);
  const play = (range?: string) => release.GET(new Request("http://arena/release", { headers: range ? { Range: range } : {} }), params);
  for (const fault of ["corrupt", "missing", "unavailable"] as const) await t.test(fault, async t => {
    await storage.putFile(key, input);
    await db.update(schema.projects).set({ visibility: "private", publicationStatus: "draft", publishedExportAssetId: null }).where(eq(schema.projects.id, project.id));
    const auditsBefore = await db.select().from(schema.projectAuditEvents).where(eq(schema.projectAuditEvents.projectId, project.id));
    const local = storage.getLocalPath.bind(storage);
    if (fault === "corrupt") { const bad = Buffer.from(media); bad[100] ^= 1; await writeFile(local(key)!, bad); }
    if (fault === "missing") await storage.delete(key);
    if (fault === "unavailable") storage.getLocalPath = () => { throw Object.assign(new Error("controlled storage outage"), { code: "EIO" }); };
    try {
      await t.test("publication preflight", async () => {
      const response = await publish(); const body = await response.text();
      assert.equal(response.status, fault === "corrupt" ? 422 : fault === "missing" ? 410 : 503, body.slice(0, 120));
      const [unchanged] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
      assert.equal(unchanged.publicationStatus, "draft"); assert.equal(unchanged.publishedExportAssetId, null);
      assert.deepEqual(await db.select().from(schema.projectAuditEvents).where(eq(schema.projectAuditEvents.projectId, project.id)), auditsBefore);
      });
      // A previously published release must also fail closed for full and ranged reads.
      await db.update(schema.projects).set({ visibility: "public", publicationStatus: "published", publishedExportAssetId: asset.id }).where(eq(schema.projects.id, project.id));
      for (const range of [undefined, "bytes=-100"]) await t.test(`public stream ${range ?? "full"}`, async () => {
        const response = await play(range); const body = await response.text();
        assert.equal(response.status, fault === "corrupt" ? 422 : fault === "missing" ? 410 : 503, body.slice(0, 120));
        assert.match(response.headers.get("content-type") ?? "", /json/);
      });
      assert.equal((await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id)))[0].status, "complete", "failed public reads must not rewrite the owner job");
    } finally { storage.getLocalPath = local; }
    await storage.putFile(key, input);
    assert.equal((await publish()).status, 200, "restored exact bytes can be published without a new asset/job");
    const response = await play(); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
    assert.deepEqual(await readFile(storage.getLocalPath(key)!), media);
  });
  await t.test("MIDI remains a private usable artifact, never a falsely playable public WAV", async t => {
    const midi = Buffer.from("4d546864000000060000000100604d54726b0000000400ff2f00", "hex");
    const filename = join(root, "score.mid"); await writeFile(filename, midi);
    const [midiJob] = await db.insert(schema.exportJobs).values({ projectId: project.id, remixSessionId: session.id, remixVersionId: version.id, requestedById: LOCAL_OWNER_ID, format: "midi", status: "complete", stage: "complete", idempotencyKey: randomUUID() }).returning();
    const midiKey = `projects/${project.id}/export/${randomUUID()}.mid`; await storage.putFile(midiKey, filename);
    const [score] = await db.insert(schema.exportAssets).values({ projectId: project.id, exportJobId: midiJob.id, remixVersionId: version.id, storageKey: midiKey, filename: "score.mid", checksumSha256: createHash("sha256").update(midi).digest("hex"), durationSeconds: 0, sampleRate: 44100, channels: 2, codec: "midi", format: "midi", fileSizeBytes: midi.length }).returning();
    await t.test("completed WAV picker excludes MIDI", async () => {
      const response = await publication.GET(new Request("http://arena/publication"), params);
      assert.equal(response.status, 200); const body = await response.json();
      assert.ok(body.exports.some((row: { id: string }) => row.id === asset.id));
      assert.ok(!body.exports.some((row: { id: string }) => row.id === score.id));
    });
    await t.test("publishing MIDI fails without replacing the previous playable release", async () => {
      const before = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0];
      const response = await publication.PUT(new Request("http://arena/publication", { method: "PUT", body: JSON.stringify({ visibility: "public", rightsAcknowledged: true, licenseCode: "all-rights-reserved", publishedExportAssetId: score.id }) }), params);
      assert.equal(response.status, 422);
      assert.deepEqual((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0], before);
    });
    await t.test("legacy public MIDI references do not masquerade as audio/wav", async () => {
      await db.update(schema.projects).set({ publishedExportAssetId: score.id }).where(eq(schema.projects.id, project.id));
      const response = await play(); await response.arrayBuffer(); assert.equal(response.status, 409);
    });
    const privateMedia = await import("../../app/api/exports/[id]/media/route");
    const response = await privateMedia.GET(new Request("http://arena/private-export"), { params: Promise.resolve({ id: midiJob.id }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/midi");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), midi);
    assert.deepEqual(await readFile(storage.getLocalPath(midiKey)!), midi);
  });

});
