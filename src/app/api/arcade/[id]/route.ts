import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { arcadeGames } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [row] = await db.select().from(arcadeGames).where(eq(arcadeGames.id, id)).limit(1);
    if (!row) return standardApiError("RESOURCE_NOT_FOUND", "Not found.", 404);
    return Response.json({ game: row });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Failed.", 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(arcadeGames).where(eq(arcadeGames.id, id));
    await logPrivacyEvent("delete_arcade", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
