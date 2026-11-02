import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { processingJobs } from "@workspace/db/waveyardSchema";
import { getLocalJobBroker, localWorkerActive } from "@workspace/arena/lib/waveyard/worker-local/broker";
import { requestSeparationCancellation } from "@workspace/arena/lib/waveyard/separation/cancel";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return Response.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    const result = await requestSeparationCancellation(db, id, getLocalJobBroker(), localWorkerActive());
    if (result.kind === "not-found") return Response.json({ error: "Job not found." }, { status: 404 });

    if (result.kind === "not-separation") {
      return Response.json({ error: "This cancellation control is only for separation jobs." }, { status: 409 });
    }
    if (result.kind === "not-active") {
      return Response.json({ error: "This separation job is no longer active." }, { status: 409 });
    }
    if (result.kind === "worker-unavailable") {
      return Response.json({
        error: "The active separation worker cannot be stopped from this runtime. The job was not changed.",
      }, { status: 503 });
    }
    if (result.kind === "worker-not-running") {
      return Response.json({
        error: "The local worker does not own this active job, so it was not marked cancelled.",
      }, { status: 409 });
    }
    if (result.kind === "unsupported-model") {
      return Response.json({
        error: "This deep-separation engine does not expose a safe stop control yet. The job was not changed.",
      }, { status: 409 });
    }
    if (result.kind === "stopping") {
      return Response.json({
        state: "stopping",
        jobId: result.job.id,
        status: result.job.status,
        stage: result.job.stage,
        message: "The worker is still stopping. The job remains active until its native process exits.",
      }, { status: 202 });
    }
    return Response.json({
      state: "cancelled",
      jobId: result.job.id,
      status: result.job.status,
      stage: result.job.stage,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "Separation cancellation could not be confirmed." }, { status: 503 });
  }
}
