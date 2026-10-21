import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { assertPrivateMedia } from "@/lib/waveyard/conversion/private-media";
import { db } from "@/db";
import { sourceAssets } from "@/db/waveyardSchema";
import { eq } from "drizzle-orm";
import { verifyStoredFile } from "../../../../../waveyard-worker/packages/dsp/src/verified-file";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { getTrack } from "@/lib/waveyard/library/service";
import { getStorage } from "@/lib/waveyard/storage";
import { capabilities, inspect, settingsSchema, tagsSchema } from "@/lib/waveyard/conversion/engine";
import { createBatch, history, publicJob, cancel, retry, enqueue, ownedJob } from "@/lib/waveyard/conversion/jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const createSchema = z.object({ action: z.literal("create"), batchId: z.string().uuid(), settings: settingsSchema, items: z.array(z.object({ trackId: z.string().uuid(), tags: tagsSchema })).min(1).max(1000) });
const actionSchema = z.object({ action: z.enum(["retry", "resume", "cancel", "inspect"]), id: z.string().uuid() });
export async function GET(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  try { const user = await requireUser(); return Response.json({ formats: await capabilities(), jobs: (await history(user.id)).map(publicJob), executor: { available: localWorkerActive(), reason: "Native conversion runs in the existing in-process Waveyard worker. External Redis converter is not implemented; use a local runtime or WAVEYARD_LOCAL_WORKER=1 without REDIS_URL." }, destination: "Arena private storage; download verified files individually. No arbitrary host folder writes." }); }
  catch { return Response.json({ error: "Conversion history/encoder inspection unavailable. Existing jobs and outputs retained; retry." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  let temporary: string | undefined;
  try {
    // JSON is bounded before parsing, including chunked requests.
    const reader = request.body?.getReader(); let bytes = 0; const chunks = [];
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); return Response.json({ error: "Conversion request exceeds 2MiB." }, { status: 413 }); } chunks.push(Buffer.from(part.value)); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const user = await requireUser();
    if (!["inspect", "cancel"].includes(body.action) && !localWorkerActive()) return Response.json({ error: "Native conversion executor unavailable. Use an in-process Waveyard runtime (WAVEYARD_LOCAL_WORKER=1 without REDIS_URL); remote conversion is not implemented." }, { status: 503 });
    if (body.action === "create") {
      const input = createSchema.parse(body);
      const jobs = await createBatch(user.id, input.batchId, input.items, input.settings);
      for (const job of jobs) if (job.status === "queued") await enqueue(job);
      return Response.json({ jobs: jobs.map(publicJob) }, { status: 202 });
    }
    const input = actionSchema.parse(body);
    if (input.action === "inspect") {
      const track = await getTrack(user.id, input.id);
      if (!track) return Response.json({ error: "Local track not found for this owner." }, { status: 404 });
      temporary = await mkdtemp(join(tmpdir(), "arena-tag-review-"));
      const path = join(temporary, "source");
      const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, track.source.id));
      await assertPrivateMedia(getStorage(), source.storageKey);
      await verifyStoredFile(getStorage(), source);
      await getStorage().getToFile(source.storageKey, path);
      return Response.json({ inspection: await inspect(path) });
    }
    if (input.action === "cancel") await cancel(user.id, input.id);
    else if (input.action === "retry") await retry(user.id, input.id);
    else { const job = await ownedJob(user.id, input.id); if (!["queued", "processing", "verifying", "publishing", "adding-to-library"].includes(job.status)) return Response.json({ error: "Use Retry for failed/cancelled items; completed output is not recreated." }, { status: 409 }); await enqueue(job); }
    return Response.json({ acknowledged: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Conversion request failed; outputs retained." }, { status: 422 }); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
