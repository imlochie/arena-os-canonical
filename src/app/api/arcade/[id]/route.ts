import { db } from "@/db";
import { arcadeGames } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isUuid } from "@/lib/api/ids";
import { deleteArcadeGame } from "@/lib/arcadeStore";
import { logPrivacyEvent } from "@/lib/privacy";
import { requireUser } from "@/lib/waveyard/local-context";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [row] = await db.select().from(arcadeGames).where(eq(arcadeGames.id, id)).limit(1);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ game: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Ownership-scoped delete: a caller can never remove someone else's game.
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
    const outcome = await deleteArcadeGame(db, id, user.id);
    if (outcome === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (outcome === "forbidden") return Response.json({ error: "this game belongs to another owner" }, { status: 403 });
    await logPrivacyEvent("delete_arcade", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
