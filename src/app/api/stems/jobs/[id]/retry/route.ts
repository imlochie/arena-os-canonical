import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stemProcessingJobs } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole } from "@/lib/stems/permissions";
import { retryStemSeparation } from "@/lib/stems/queue";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireStemUser();
    const { id } = await params;
    const [job] = await db.select().from(stemProcessingJobs).where(eq(stemProcessingJobs.id, id)).limit(1);
    if (!job) return Response.json({ error: "Stem processing job not found." }, { status: 404 });
    await requireStemProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed") return Response.json({ error: "Only failed jobs can be retried." }, { status: 409 });
    await db.update(stemProcessingJobs).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(stemProcessingJobs.id, id));
    await retryStemSeparation({ processingJobId: job.id, projectId: job.projectId, sourceAssetId: job.sourceAssetId, model: job.model, requestedDevice: job.requestedDevice as "auto" | "cpu" | "cuda" });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem retry failed", error);
    return Response.json({ error: "Could not enqueue the retry." }, { status: 503 });
  }
}
