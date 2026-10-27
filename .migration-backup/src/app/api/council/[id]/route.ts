import { db } from "@/db";
import { councilArtifacts, councilRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [run] = await db.select().from(councilRuns).where(eq(councilRuns.id, id)).limit(1);
    if (!run) return Response.json({ error: "not found" }, { status: 404 });
    const artifacts = await db.select().from(councilArtifacts).where(eq(councilArtifacts.runId, id));
    return Response.json({ run, artifacts });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(councilArtifacts).where(eq(councilArtifacts.runId, id));
    await db.delete(councilRuns).where(eq(councilRuns.id, id));
    await logPrivacyEvent("delete_council", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
