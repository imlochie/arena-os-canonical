import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { exportJobs, getDb } from "@waveyard/database";
import { enqueueExport, getExportQueue } from "@waveyard/queue";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [job] = await db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, id))
      .limit(1);
    if (!job)
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed")
      return NextResponse.json(
        { error: "Only a failed export can be retried." },
        { status: 409 },
      );

    const queueJob = await getExportQueue().getJob(job.id);
    if (queueJob) await queueJob.retry();
    else
      await enqueueExport({
        exportJobId: job.id,
        projectId: job.projectId,
        remixSessionId: job.remixSessionId,
        remixVersionId: job.remixVersionId,
        format: "wav",
      });
    const [updated] = await db
      .update(exportJobs)
      .set({
        status: "queued",
        stage: "queued",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(exportJobs.id, job.id))
      .returning();
    return NextResponse.json({ job: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("export retry failed", error);
    return NextResponse.json(
      { error: "Export retry could not be queued." },
      { status: 503 },
    );
  }
}
