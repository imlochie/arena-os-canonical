/** Public Archive intake uses existing processing_jobs + LocalJobBroker + library.
 * No placeholder source assets. Explicit resume after restart restarts download,
 * not byte-range resumption. Advisory locks fence separate worker processes.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { processingJobs, projects, playlists, playlistItems, tracks, sourceAssets } from "@/db/waveyardSchema";
import { getStorage } from "./storage";
import { verifyStoredFile } from "../../../waveyard-worker/packages/dsp/src/verified-file";
import { inspectArchiveAudio, importArchiveAudio } from "./archive-audio";
import { getLocalJobBroker, localWorkerActive } from "./worker-local/broker";

type Job = typeof processingJobs.$inferSelect;
type Intent = { ownerId: string; batchId: string; index: number; fingerprint: string; id: string; file: string; title: string; expected: { sha1: string; bytes: number; licenceUrl: string } };
const aborts = new Map<string, AbortController>();
const QUEUE = "waveyard-acquisition";
export const intent = (job: Job) => JSON.parse(job.metadata) as Intent;
export function publicAcquisition(job: Job) {
  const m = JSON.parse(job.metadata);
  return { id: job.id, batchId: m.batchId as string, index: m.index as number, file: m.file as string,
    title: m.title as string, status: job.status, stage: job.stage, attempts: job.attempts,
    receivedBytes: Number(m.receivedBytes ?? 0), totalBytes: Number(m.expected?.bytes ?? 0), error: job.errorMessage,
    outputTrackId: m.outputTrackId as string | undefined, events: m.events ?? [], publications: m.publications ?? [],
    notice: "Resume restarts acquisition from zero. Cancel near publication can leave a verified library asset; it is retained, never overwritten." };
}
export async function acquisitionHistory(ownerId: string) {
  return (await db.select({ job: processingJobs }).from(processingJobs).innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(and(eq(projects.ownerId, ownerId), eq(processingJobs.type, "acquisition"))).orderBy(desc(processingJobs.createdAt)).limit(500)).map(r => r.job);
}
export async function ownedAcquisition(ownerId: string, id: string) {
  const [row] = await db.select({ job: processingJobs }).from(processingJobs).innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(and(eq(processingJobs.id, id), eq(projects.ownerId, ownerId), eq(processingJobs.type, "acquisition")));
  if (!row || intent(row.job).ownerId !== ownerId) throw new Error("Acquisition not found for this owner.");
  return row.job;
}
export async function createAcquisitions(input: { ownerId: string; batchId: string; id: string; files: string[]; rightsReviewed: boolean }, fetcher?: typeof fetch) {
  if (input.rightsReviewed !== true) throw new Error("Review recording/composition rights and source terms before enqueueing.");
  if (!input.files.length || input.files.length > 100 || new Set(input.files).size !== input.files.length) throw new Error("Select 1–100 distinct files in the intended order.");
  const fingerprint = createHash("sha256").update(JSON.stringify({ id: input.id, files: input.files })).digest("hex");
  // An acknowledged intent can be replayed during provider outage. Its pinned
  // versions/consent are immutable; execution still revalidates current rights.
  const [prior] = await db.select().from(projects).where(eq(projects.id, input.batchId));
  if (prior) {
    if (prior.ownerId !== input.ownerId || prior.kind !== "acquisition") throw new Error("Batch identity belongs to a different intent or owner.");
    const rows = await db.select().from(processingJobs).where(eq(processingJobs.projectId, input.batchId));
    if (rows.length !== input.files.length || rows.some(row => intent(row).fingerprint !== fingerprint)) throw new Error("Batch identity conflict; use the original selection or a new request.");
    return rows.sort((a, b) => intent(a).index - intent(b).index);
  }
  const item = await inspectArchiveAudio(input.id, fetcher);
  if (!item.licence) throw new Error("No unambiguous supported licence; reference only.");
  const prepared = input.files.map((name, index) => {
    const file = item.files.find(f => f.name === name);
    if (!file?.importEligible || !file.sha1) throw new Error(`${name}: eligible audio and provider integrity digest required.`);
    const hash = createHash("sha256").update(`${input.ownerId}:${input.batchId}:${index}`).digest("hex");
    const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const metadata: Intent = { ownerId: input.ownerId, batchId: input.batchId, index, fingerprint, id: item.id, file: name, title: item.title,
      expected: { sha1: file.sha1, bytes: file.bytes, licenceUrl: item.licence!.url } };
    return { id, projectId: input.batchId, type: "acquisition", status: "queued", stage: "queued", sourceAssetId: null,
      idempotencyKey: `acquisition:${id}`, model: "none", requestedDevice: "cpu", metadata: JSON.stringify(metadata) };
  });
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`acquisition-batch:${input.batchId}`},0))`);
    const [existing] = await tx.select().from(projects).where(eq(projects.id, input.batchId));
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.kind !== "acquisition") throw new Error("Batch identity belongs to a different intent or owner.");
      const rows = await tx.select().from(processingJobs).where(eq(processingJobs.projectId, input.batchId));
      if (rows.length !== prepared.length || rows.some(row => intent(row).fingerprint !== fingerprint)) throw new Error("Batch identity conflict; use the original selection or a new request.");
      return;
    }
    await tx.insert(projects).values({ id: input.batchId, ownerId: input.ownerId, kind: "acquisition", title: `Acquire — ${item.title}` });
    await tx.insert(playlists).values({ id: input.batchId, ownerId: input.ownerId, name: item.title || item.id });
    await tx.insert(processingJobs).values(prepared);
  });
  return Promise.all(prepared.map(row => ownedAcquisition(input.ownerId, row.id)));
}
export async function enqueueAcquisition(job: Job) {
  if (!localWorkerActive()) throw new Error("Acquisition needs the existing in-process Waveyard worker; no remote executor is implemented.");
  getLocalJobBroker().register(QUEUE, async payload => executeAcquisition(String(payload.id)));
  await getLocalJobBroker().submit(QUEUE, `${job.id}:${randomUUID()}`, { id: job.id });
}
export async function cancelAcquisition(ownerId: string, id: string) {
  await ownedAcquisition(ownerId, id);
  await pool.query("UPDATE processing_jobs SET status='cancelled',stage='cancelled',metadata=(jsonb_set(metadata::jsonb,'{runId}',to_jsonb($2::text)) || jsonb_build_object('events',coalesce(metadata::jsonb->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'event','cancelled'))))::text,updated_at=now() WHERE id=$1 AND status <> 'complete'", [id, randomUUID()]);
  aborts.get(id)?.abort();
}
export async function resumeAcquisition(ownerId: string, id: string, retry = false) {
  const job = await ownedAcquisition(ownerId, id);
  if (job.status === "complete") {
    try { await verifyAcquisitionOutput(job); } catch (error) {
      await pool.query("UPDATE processing_jobs SET status='failed',stage='published-output-invalid',error_message=$2,updated_at=now() WHERE id=$1 AND status='complete'", [id, String(error)]); throw error;
    }
    return;
  }
  if (["failed", "cancelled"].includes(job.status) && !retry) throw new Error("Use explicit Retry for failed or cancelled acquisition.");
  if (retry) await pool.query("UPDATE processing_jobs SET status='queued',stage='queued',error_message=null,error_code=null,completed_at=null,metadata=(metadata::jsonb || jsonb_build_object('events',coalesce(metadata::jsonb->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'event','retry','reason',error_message))))::text,updated_at=now() WHERE id=$1 AND status IN ('failed','cancelled')", [id]);
  await enqueueAcquisition(await ownedAcquisition(ownerId, id));
}
async function verifyAcquisitionOutput(job: Job) {
  const outputId = JSON.parse(job.metadata).outputTrackId;
  const [row] = await db.select({ source: sourceAssets }).from(tracks).innerJoin(sourceAssets, eq(sourceAssets.id, tracks.sourceAssetId))
    .where(and(eq(tracks.id, outputId), eq(tracks.ownerId, intent(job).ownerId)));
  if (!row || row.source.id !== job.sourceAssetId) throw new Error("Published library identity changed or unavailable; restore the original asset.");
  await verifyStoredFile(getStorage(), row.source);
}
export async function executeAcquisition(id: string, fetcher?: typeof fetch) {
  const connection = await pool.connect(), controller = new AbortController(), runId = randomUUID();
  let heartbeat: Promise<void> | undefined;
  let locked = false, timer: ReturnType<typeof setInterval> | undefined;
  try {
    locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`acquisition:${id}`])).rows[0].locked;
    if (!locked) return;
    const [job] = await db.select().from(processingJobs).where(and(eq(processingJobs.id, id), eq(processingJobs.type, "acquisition")));
    if (!job || ["complete", "failed", "cancelled"].includes(job.status)) return;
    const m = intent(job); await ownedAcquisition(m.ownerId, id);
    const claimed = await connection.query("UPDATE processing_jobs SET status='processing',stage='reviewing-source',attempts=attempts+1,started_at=now(),updated_at=now(),metadata=(metadata::jsonb || jsonb_build_object('runId',$2::text,'receivedBytes',0,'events',coalesce(metadata::jsonb->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'event','started-or-resumed','runId',$2::text))))::text WHERE id=$1 AND status NOT IN ('cancelled','complete','failed') RETURNING id", [id, runId]);
    if (!claimed.rowCount) return;
    aborts.set(id, controller);
    let checking = false;
    timer = setInterval(() => { if (checking) return; checking = true; heartbeat = connection.query("SELECT status,metadata::jsonb->>'runId' AS run FROM processing_jobs WHERE id=$1", [id]).then(r => {
      if (!r.rows[0] || r.rows[0].status === "cancelled" || r.rows[0].run !== runId) controller.abort();
    }).catch(() => controller.abort()).finally(() => { checking = false; }); }, 250);
    let lastProgress = 0;
    const result = await importArchiveAudio({ ownerId: m.ownerId, id: m.id, file: m.file, rightsReviewed: true, expected: m.expected, signal: controller.signal,
      onStage: async stage => {
        const saved = await connection.query("UPDATE processing_jobs SET stage=$2,updated_at=now() WHERE id=$1 AND metadata::jsonb->>'runId'=$3 AND status='processing' RETURNING id", [id, stage, runId]);
        if (!saved.rowCount) { controller.abort(); controller.signal.throwIfAborted(); }
      },
      onProgress: async (received, total) => {
        if (Date.now() - lastProgress < 250 && received !== total) return; lastProgress = Date.now();
        const saved = await connection.query("UPDATE processing_jobs SET stage='downloading',metadata=jsonb_set(metadata::jsonb,'{receivedBytes}',to_jsonb($2::bigint))::text,updated_at=now() WHERE id=$1 AND metadata::jsonb->>'runId'=$3 AND status='processing' RETURNING id", [id, received, runId]);
        if (!saved.rowCount) { controller.abort(); controller.signal.throwIfAborted(); }
      },
    }, fetcher);
    // Publication may race cancellation: append the genuine result without
    // changing cancelled state or overwriting a newer attempt's identity.
    const [published] = await db.select({ sourceAssetId: tracks.sourceAssetId }).from(tracks).where(and(eq(tracks.id, result.track.id), eq(tracks.ownerId, m.ownerId)));
    if (!published) throw new Error("Published library track is no longer available; no completion claimed.");
    const publication = { runId, trackId: result.track.id, at: new Date().toISOString() };
    await connection.query("UPDATE processing_jobs SET metadata=(metadata::jsonb || jsonb_build_object('publications',coalesce(metadata::jsonb->'publications','[]'::jsonb)||$2::jsonb))::text WHERE id=$1", [id, JSON.stringify([publication])]);
    await db.transaction(async tx => {
      const [source] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, published.sourceAssetId));
      if (!source) throw new Error("Published source missing; no completion claimed.");
      await verifyStoredFile(getStorage(), source);
      const changed = await tx.execute(sql`UPDATE processing_jobs SET status='complete',stage='complete',source_asset_id=${published.sourceAssetId},completed_at=now(),updated_at=now(),error_message=null,metadata=(metadata::jsonb || jsonb_build_object('outputTrackId',${result.track.id}::text))::text WHERE id=${id} AND metadata::jsonb->>'runId'=${runId} AND status='processing' RETURNING id`);
      if (!changed.rowCount) return;
      await tx.insert(playlistItems).values({ playlistId: m.batchId, trackId: result.track.id, position: m.index }).onConflictDoNothing();
    });
  } catch (error) {
    await connection.query("UPDATE processing_jobs SET status='failed',stage='failed',error_code='acquisition_failed',error_message=$2,metadata=(metadata::jsonb || jsonb_build_object('events',coalesce(metadata::jsonb->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'event','failed','reason',$2::text,'runId',$3::text))))::text,updated_at=now() WHERE id=$1 AND metadata::jsonb->>'runId'=$3 AND status <> 'cancelled'", [id, error instanceof Error ? error.message : String(error), runId]);
    throw error;
  } finally {
    if (timer) clearInterval(timer); await heartbeat; if (aborts.get(id) === controller) aborts.delete(id);
    if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`acquisition:${id}`]).catch(() => {});
    connection.release();
  }
}
