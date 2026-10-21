import { z } from "zod";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { acquisitionHistory, createAcquisitions, publicAcquisition, enqueueAcquisition, cancelAcquisition, resumeAcquisition } from "@/lib/waveyard/acquisition-jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), batchId: z.string().uuid(), id: z.string().min(1).max(100), files: z.array(z.string().min(1).max(512)).min(1).max(100), rightsReviewed: z.literal(true) }),
  z.object({ action: z.enum(["cancel", "retry", "resume"]), id: z.string().uuid() }),
]);
export async function GET(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  try { const owner = await requireUser(); return Response.json({ jobs: (await acquisitionHistory(owner.id)).map(publicAcquisition), executorAvailable: localWorkerActive() }); }
  catch { return Response.json({ error: "Acquisition history unavailable; durable jobs retained." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  try {
    const reader = request.body?.getReader(); const chunks = []; let bytes = 0;
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
      if (bytes > 65536) { await reader.cancel(); return Response.json({ error: "Acquisition request exceeds64KiB." }, { status: 413 }); } chunks.push(Buffer.from(part.value)); }
    const input = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))), owner = await requireUser();
    if (input.action !== "cancel" && !localWorkerActive()) return Response.json({ error: "Enable the in-process Waveyard worker; remote acquisition is not implemented." }, { status: 503 });
    if (input.action === "create") {
      const jobs = await createAcquisitions({ ...input, ownerId: owner.id });
      for (const job of jobs) if (job.status === "queued") await enqueueAcquisition(job);
      return Response.json({ jobs: jobs.map(publicAcquisition) }, { status: 202 });
    }
    if (input.action === "cancel") await cancelAcquisition(owner.id, input.id);
    else await resumeAcquisition(owner.id, input.id, input.action === "retry");
    return Response.json({ acknowledged: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Acquisition failed; no audio success claimed." }, { status: 422 }); }
}
