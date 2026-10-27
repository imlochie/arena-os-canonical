
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  processingJobs,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return Response.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "viewer");
    return Response.json({ job });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
