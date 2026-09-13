import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { assistants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getModel } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const patch: Partial<typeof assistants.$inferInsert> = {};
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 80);
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 300);
    if (body.systemPrompt !== undefined) patch.systemPrompt = String(body.systemPrompt).slice(0, 4000);
    if (body.baseModel !== undefined) {
      getModel(String(body.baseModel));
      patch.baseModel = String(body.baseModel);
    }
    if (body.temperature !== undefined)
      patch.temperature = Math.min(2, Math.max(0, Number(body.temperature)));
    if (body.avatar !== undefined) patch.avatar = String(body.avatar).slice(0, 8);
    const updated = await db.update(assistants).set(patch).where(eq(assistants.id, id)).returning();
    if (!updated[0]) return standardApiError("RESOURCE_NOT_FOUND", "Not found.", 404);
    return Response.json({ assistant: updated[0] });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Update failed.", 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(assistants).where(eq(assistants.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
