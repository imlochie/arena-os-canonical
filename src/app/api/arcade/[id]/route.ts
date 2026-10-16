import { db } from "@/db";
import { arcadeGames } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";
import { requireApiAccess } from "@/lib/security/api-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "invalid id" }, { status: 400 });
    const [row] = await db.select().from(arcadeGames).where(eq(arcadeGames.id, id)).limit(1);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ game: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "invalid id" }, { status: 400 });
    await db.delete(arcadeGames).where(eq(arcadeGames.id, id));
    await logPrivacyEvent("delete_arcade", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
