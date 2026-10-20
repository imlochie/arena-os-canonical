/** Durable native conversions reuse processing_jobs and the serial LocalJobBroker.
 * PostgreSQL session locks fence different processes; run IDs fence late writes.
 * Output intent/checksum precedes immutable publication. Recovery never overwrites.
 */
import { assertPrivateMedia } from "./private-media";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq, desc } from "drizzle-orm";
import { db, pool } from "@/db";
import { processingJobs, projects, sourceAssets, tracks } from "@/db/waveyardSchema";
import { checksumFile } from "../audio";
import { getStorage } from "../storage";
import { localWorkerActive, getLocalJobBroker } from "../worker-local/broker";
import { addTrackFromAudioFile } from "../library/service";
import { verifyStoredFile } from "../../../../waveyard-worker/packages/dsp/src/verified-file";
import { convert, inspect, outputName, verify, formats, type Settings, type Tags } from "./engine";

const QUEUE = "waveyard-conversion";
type Job = typeof processingJobs.$inferSelect;
type Meta = { version: 1; ownerId: string; batchId: string; index: number; trackId: string; sourceChecksum: string; fingerprint: string; settings: Settings; tags: Tags; name: string; outputKey: string; attempts: Array<{ at: string; runId: string }>; events?: Array<{at:string;event:string;reason?:string}>; runId?: string; verification?: Awaited<ReturnType<typeof verify>>; outputTrackId?: string; outputSourceId?: string };
const globals = globalThis as typeof globalThis & { __conversionAborts?: Map<string, AbortController> };
const aborts = globals.__conversionAborts ??= new Map();
export function metadata(job: Job) { return JSON.parse(job.metadata) as Meta; }
export async function ownedJob(ownerId: string, id: string) {
  const [row] = await db.select({ job: processingJobs }).from(processingJobs).innerJoin(projects, eq(projects.id, processingJobs.projectId)).where(and(eq(processingJobs.id, id), eq(processingJobs.type, "conversion"), eq(projects.ownerId, ownerId)));
  if (!row || metadata(row.job).ownerId !== ownerId) throw new Error("Conversion not found for this owner.");
  return row.job;
}
export async function history(ownerId: string) {
  const rows = await db.select({ job: processingJobs }).from(processingJobs).innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(and(eq(processingJobs.type, "conversion"), eq(projects.ownerId, ownerId))).orderBy(desc(processingJobs.createdAt)).limit(1000);
  return rows.map(row => row.job).filter(job => metadata(job).ownerId === ownerId);
}
export function publicJob(job: Job) {
  const m = metadata(job);
  return { id: job.id, status: job.status, stage: job.stage, error: job.errorMessage, createdAt: job.createdAt, batchId: m.batchId, index: m.index, name: m.name, settings: m.settings, tags: m.tags, attempts: job.attempts, verification: m.verification ? { checksumSha256: m.verification.checksumSha256, fileSizeBytes: m.verification.fileSizeBytes, fullyDecoded: m.verification.fullyDecoded, warnings: m.verification.warnings, actual: { codec: m.verification.actual.codec, sampleRate: m.verification.actual.sampleRate, channels: m.verification.actual.channels, durationSeconds: m.verification.actual.durationSeconds } } : undefined, outputTrackId: m.outputTrackId, outputSourceId: m.outputSourceId, sourceChecksum: m.sourceChecksum, history: m.events ?? [] };
}
export async function createBatch(ownerId: string, batchId: string, items: Array<{ trackId: string; tags: Tags }>, settings: Settings) {
  const fingerprint = createHash("sha256").update(JSON.stringify({ items, settings })).digest("hex");
  const prepared: Array<typeof processingJobs.$inferInsert & { id: string; metadata: string }> = [];
  for (const [index, item] of items.entries()) {
    const [row] = await db.select({ track: tracks, source: sourceAssets }).from(tracks).innerJoin(sourceAssets, eq(tracks.sourceAssetId, sourceAssets.id)).where(and(eq(tracks.id, item.trackId), eq(tracks.ownerId, ownerId)));
    if (!row) throw new Error(`Item ${index + 1}: verified local library track not found for this owner.`);
    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id,row.source.projectId),eq(projects.ownerId,ownerId)));
    if (!project || row.track.projectId !== project.id) throw new Error("Source asset ownership does not match this library track.");
    const hash = createHash("sha256").update(`${ownerId}:${batchId}:${index}`).digest("hex");
    const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const name = outputName(settings, item.tags, id);
    const m: Meta = { version: 1, ownerId, batchId, index, trackId: item.trackId, sourceChecksum: row.source.checksumSha256, fingerprint, settings, tags: item.tags, name, outputKey: `projects/${row.source.projectId}/export/conversion-${id}/${name}`, attempts: [] };
    prepared.push({ id, projectId: row.source.projectId, sourceAssetId: row.source.id, type: "conversion", status: "queued", stage: "queued", idempotencyKey: `conversion:${id}`, model: settings.format, requestedDevice: "cpu", metadata: JSON.stringify(m) });
  }
  await db.transaction(async tx => {
    for (const item of prepared) {
      await tx.insert(processingJobs).values(item).onConflictDoNothing({ target: processingJobs.id });
      const [existing] = await tx.select().from(processingJobs).where(eq(processingJobs.id, item.id));
      if (metadata(existing).fingerprint !== JSON.parse(item.metadata).fingerprint) throw new Error("Batch request identity already exists with different settings. Create a new batch instead.");
    }
  });
  return Promise.all(prepared.map(row => ownedJob(ownerId, row.id)));
}
export async function enqueue(job: Job) {
  if (!localWorkerActive()) throw new Error("Native conversion needs the in-process Waveyard worker. Enable WAVEYARD_LOCAL_WORKER=1 without REDIS_URL on this host; no remote converter is implemented.");
  const broker = getLocalJobBroker();
  broker.register(QUEUE, async payload => { await execute(String(payload.id)); });
  return broker.submit(QUEUE, job.id, { id: job.id });
}
export async function cancel(ownerId: string, id: string) {
  await ownedJob(ownerId, id);
  // Preserve publication intent/result: cancellation never asserts bytes don't exist.
  await pool.query("UPDATE processing_jobs SET status='cancelled',stage='cancelled',metadata=(jsonb_set(metadata::jsonb,'{runId}',to_jsonb($2::text)) || jsonb_build_object('events',coalesce(metadata::jsonb->'events','[]'::jsonb)||$3::jsonb))::text,updated_at=now() WHERE id=$1 AND status <> 'complete'", [id, randomUUID(), JSON.stringify([{at:new Date().toISOString(),event:"cancelled",reason:"Owner requested cancellation; any verified publication remains retained."}])]);
  aborts.get(id)?.abort();
}
async function verifyCompleted(job: Job) {
  const m = metadata(job);
  try {
    if (!m.verification) throw new Error("Completion has no verification receipt.");
    await assertPrivateMedia(getStorage(), m.outputKey);
    await verifyStoredFile(getStorage(), { storageKey: m.outputKey, ...m.verification });
  } catch (error) {
    await pool.query("UPDATE processing_jobs SET status='failed',stage='verification-failed',error_code='published_output_invalid',error_message=$2,updated_at=now() WHERE id=$1 AND status='complete'", [job.id, error instanceof Error ? error.message : "Published output unavailable; restore storage."]);
    throw error;
  }
}
export async function retry(ownerId: string, id: string) {
  const job = await ownedJob(ownerId, id);
  if (job.status === "complete") {
    await verifyCompleted(job);
    return;
  }
  await pool.query("UPDATE processing_jobs SET status='queued',stage='queued',metadata=(metadata::jsonb || jsonb_build_object('events',coalesce(metadata::jsonb->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'event','retry','reason',error_message))))::text,error_code=null,error_message=null,completed_at=null,updated_at=now() WHERE id=$1 AND status IN ('failed','cancelled')", [id]);
  await enqueue(await ownedJob(ownerId, id));
}
export async function execute(id: string) {
  const connection = await pool.connect();
  let locked = false, temp: string | undefined, beat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController(), runId = randomUUID();
  let m: Meta | undefined;
  try {
    locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`conversion:${id}`])).rows[0].locked;
    if (!locked) return;
    const [job] = await db.select().from(processingJobs).where(and(eq(processingJobs.id, id), eq(processingJobs.type, "conversion")));
    if (!job || ["cancelled", "failed"].includes(job.status)) return;
    m = metadata(job);
    const storage = getStorage();
    if (job.status === "complete") {
      await verifyCompleted(job);
      return;
    }
    // Only our authenticated enqueue creates rows; fresh ownership is checked again.
    await ownedJob(m.ownerId, id);
    m.runId = runId; (m.events ??= []).push({at:new Date().toISOString(),event:"started-or-resumed"}); m.attempts.push({ at: new Date().toISOString(), runId });
    const claimed = await connection.query("UPDATE processing_jobs SET status='processing',stage='processing',metadata=$2,attempts=attempts+1,started_at=now(),updated_at=now() WHERE id=$1 AND status <> 'cancelled' RETURNING id", [id, JSON.stringify(m)]);
    if (!claimed.rowCount) return;
    aborts.set(id, controller);
    const check = async () => {
      const state = await connection.query("SELECT status,metadata FROM processing_jobs WHERE id=$1", [id]);
      if (!state.rows[0] || state.rows[0].status === "cancelled" || JSON.parse(state.rows[0].metadata).runId !== runId) { controller.abort(); throw new Error("Conversion cancelled or superseded; publication not acknowledged."); }
      if (controller.signal.aborted) throw new Error("Conversion interrupted; resume to reconcile retained output.");
    };
    let checking = false;
    beat = setInterval(() => { if (checking) return; checking = true; void check().catch(() => controller.abort()).finally(() => { checking = false; }); }, 1000);
    const save = async (stage: string, status = stage) => {
      await check();
      const result = await connection.query("UPDATE processing_jobs SET status=$3,stage=$3,metadata=$2,updated_at=now(),error_message=null WHERE id=$1 AND metadata::jsonb->>'runId'=$4 AND status <> 'cancelled' RETURNING id", [id, JSON.stringify(m), status, runId]);
      if (!result.rowCount) throw new Error("Conversion lease lost; late result not published.");
    };
    if (!job.sourceAssetId) throw new Error("Conversion requires a verified local source asset.");
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, job.sourceAssetId));
    if (!source || source.projectId !== job.projectId || source.checksumSha256 !== m.sourceChecksum) throw new Error("Source identity changed or unavailable.");
    temp = await mkdtemp(join(tmpdir(), "arena-conversion-"));
    const input = join(temp, "source");
    // Private media is read through the storage abstraction, never a supplied host path.
    await assertPrivateMedia(storage, source.storageKey);
    await assertPrivateMedia(storage, m.outputKey, true);
    await verifyStoredFile(storage, source);
    await storage.getToFile(source.storageKey, input);
    if (await checksumFile(input) !== m.sourceChecksum) throw new Error("Source checksum changed during acquisition.");
    const sourceInfo = await inspect(input);
    const effectiveTags = { ...sourceInfo.tags, ...m.tags };
    let output = join(temp, `output.${formats[m.settings.format].ext}`);
    if (await storage.exists(m.outputKey)) {
      if (!m.verification) throw new Error("Output exists without a verification intent; retained, not overwritten. Inspect/reconcile before retrying.");
      await assertPrivateMedia(storage, m.outputKey);
      await verifyStoredFile(storage, { storageKey: m.outputKey, ...m.verification });
      await storage.getToFile(m.outputKey, output);
      const recovered = await verify(output, sourceInfo, m.settings, effectiveTags, controller.signal);
      if (recovered.checksumSha256 !== m.verification.checksumSha256) throw new Error("Published output changed while being recovered; original receipt retained, no replacement certified.");
      m.verification = recovered;
    } else {
      await convert(input, output, m.settings, effectiveTags, controller.signal);
      await save("verifying");
      m.verification = await verify(output, sourceInfo, m.settings, effectiveTags, controller.signal);
      await save("publishing"); // durable receipt BEFORE physical publication
      await storage.putImmutableStream(m.outputKey, createReadStream(output), { bytes: m.verification.fileSizeBytes, sha256: m.verification.checksumSha256 });
    }
    await check();
    await assertPrivateMedia(storage, m.outputKey);
    // New outputs were fully decoded before publication; recovered outputs were
    // fully decoded above. Verify the physically retrievable identity here rather
    // than redundantly decoding the same temporary file a second time.
    await verifyStoredFile(storage, { storageKey: m.outputKey, ...m.verification! });
    await save("adding-to-library");
    const result = await addTrackFromAudioFile({ ownerId: m.ownerId, filePath: output, filename: m.name.split("/").at(-1)!, mimeType: formats[m.settings.format].mime, title: m.tags.title, artist: m.tags.artist, album: m.tags.album, existingObject: { storageKey: m.outputKey, checksumSha256: m.verification.checksumSha256 }, prepareSeparation: false });
    m.outputTrackId = result.track.id;
    const [track] = await db.select().from(tracks).where(eq(tracks.id, result.track.id));
    m.outputSourceId = track.sourceAssetId;
    (m.events ??= []).push({at:new Date().toISOString(),event:"completion-verification-finished",reason:"Published identity, full audio decode and library asset verified; SQL completion still requires acknowledgement."});
    await save("complete");
    await connection.query("UPDATE processing_jobs SET completed_at=now() WHERE id=$1 AND status='complete' AND metadata::jsonb->>'runId'=$2", [id, runId]);
  } catch (error) {
    if (m?.runId === runId) {
      const reason=error instanceof Error?error.message.slice(0,1600):"Conversion failed";
      (m.events ??= []).push({at:new Date().toISOString(),event:"failed",reason});
      await connection.query("UPDATE processing_jobs SET status='failed',stage='failed',error_code='conversion_failed',error_message=$2,metadata=$4,updated_at=now() WHERE id=$1 AND metadata::jsonb->>'runId'=$3 AND status <> 'cancelled'", [id, reason, runId, JSON.stringify(m)]).catch(() => undefined);
    }
    throw error;
  } finally {
    if (beat) clearInterval(beat);
    if (aborts.get(id) === controller) aborts.delete(id);
    if (temp) await rm(temp, { recursive: true, force: true });
    if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`conversion:${id}`]).catch(() => undefined);
    connection.release();
    if (locked && m) setTimeout(() => {
      void ownedJob(m!.ownerId, id).then(job => { if (job.status === "queued") return enqueue(job); }).catch(() => undefined);
    }, 0);

  }
}
