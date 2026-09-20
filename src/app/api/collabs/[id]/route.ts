import { db } from "@/db";
import { collabs, collabContributions } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [collab] = await db.select().from(collabs).where(eq(collabs.id, id)).limit(1);
    if (!collab) return Response.json({ error: "not found" }, { status: 404 });
    const contributions = await db
      .select()
      .from(collabContributions)
      .where(eq(collabContributions.collabId, id))
      .orderBy(asc(collabContributions.round), asc(collabContributions.contribIndex));
    return Response.json({ collab, contributions });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

// DELETE → right to erasure for a single collab + contributions
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(collabContributions).where(eq(collabContributions.collabId, id));
    await db.delete(collabs).where(eq(collabs.id, id));
    await logPrivacyEvent("delete_collab", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
