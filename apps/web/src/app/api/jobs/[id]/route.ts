import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, processingJobs } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await getDb().select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "viewer");
    return NextResponse.json({ job });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
