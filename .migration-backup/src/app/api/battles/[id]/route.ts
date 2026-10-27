import { db } from "@/db";
import { battles, battleMessages, assistants, models } from "@/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

// GET → full battle detail incl. thread (masked while unvoted)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    if (!battle) return Response.json({ error: "not found" }, { status: 404 });

    const msgs = await db
      .select()
      .from(battleMessages)
      .where(eq(battleMessages.battleId, id))
      .orderBy(asc(battleMessages.createdAt))
      .limit(100);

    if (!battle.winner) {
      return Response.json({
        battle: {
          ...battle,
          modelAId: "???",
          modelBId: "???",
          assistantAId: null,
          assistantBId: null,
        },
        messages: msgs,
        blind: true,
      });
    }

    // Voted → include display names
    const modelRows = await db
      .select()
      .from(models)
      .where(inArray(models.id, [battle.modelAId, battle.modelBId]));
    const mName = new Map(modelRows.map((m) => [m.id, m.name]));
    let aNameA: string | null = null;
    let aNameB: string | null = null;
    const aIds = [battle.assistantAId, battle.assistantBId].filter(Boolean) as string[];
    if (aIds.length) {
      const aRows = await db.select().from(assistants).where(inArray(assistants.id, aIds));
      const byId = new Map(aRows.map((a) => [a.id, `${a.avatar} ${a.name}`]));
      aNameA = battle.assistantAId ? (byId.get(battle.assistantAId) ?? null) : null;
      aNameB = battle.assistantBId ? (byId.get(battle.assistantBId) ?? null) : null;
    }
    return Response.json({
      battle,
      messages: msgs,
      blind: false,
      names: {
        a: aNameA ? `${aNameA} (${mName.get(battle.modelAId) ?? battle.modelAId})` : (mName.get(battle.modelAId) ?? battle.modelAId),
        b: aNameB ? `${aNameB} (${mName.get(battle.modelBId) ?? battle.modelBId})` : (mName.get(battle.modelBId) ?? battle.modelBId),
      },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

// DELETE → right to erasure for a single battle + its thread
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(battleMessages).where(eq(battleMessages.battleId, id));
    await db.delete(battles).where(eq(battles.id, id));
    await logPrivacyEvent("delete_battle", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
