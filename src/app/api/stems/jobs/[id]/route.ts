import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stemProcessingJobs } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole } from "@/lib/stems/permissions";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireStemUser();
    const { id } = await params;
    const [job] = await db.select().from(stemProcessingJobs).where(eq(stemProcessingJobs.id, id)).limit(1);
    if (!job) return Response.json({ error: "Stem processing job not found." }, { status: 404 });
    await requireStemProjectRole(user.id, job.projectId, "viewer");
    return Response.json({ job });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem job lookup failed", error);
    return Response.json({ error: "Could not read the processing job." }, { status: 500 });
  }
}
