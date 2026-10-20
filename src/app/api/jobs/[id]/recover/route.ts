import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/waveyardSchema";
import { requireUser, requireProjectRole } from "@/lib/waveyard/local-context";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { reconcileSeparation } from "@/lib/waveyard/separation/recovery";
import { enqueueFromRow } from "@/lib/waveyard/separation/retry";
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job || job.type !== "separation") return NextResponse.json({ error: "Separation job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (!localWorkerActive()) return NextResponse.json({ error: "Recovery requires this machine's native worker; remote ownership is not inferred." }, { status: 503 });
    const result = await reconcileSeparation(db, id);
    if (["owner-not-proven-dead", "legacy-unknown-owner", "inconsistent-bank-preserved"].includes(result)) return NextResponse.json({ error: `Recovery preserved all audio: ${result}. The executor is live or cannot safely be reclaimed.`, result }, { status: 409 });
    if (result === "queued") await enqueueFromRow(job);
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, id));
    return NextResponse.json({ result, job: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Separation recovery pending", error);
    return NextResponse.json({ error: "Recovery could not verify storage/database state. Audio was retained; retry recovery when services are available." }, { status: 503 });
  }
}
