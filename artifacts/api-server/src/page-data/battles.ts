import { db } from "@workspace/db";
import { battles, battleMessages, assistants, models } from "@workspace/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
export async function loadPage(params: Record<string,string>) {
  const { id } = await params;
  const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
  if (!battle) return Response.json({ error: "Not found" }, { status: 404 });

  const msgs = await db
    .select()
    .from(battleMessages)
    .where(eq(battleMessages.battleId, id))
    .orderBy(asc(battleMessages.createdAt))
    .limit(100);

  const voted = !!battle.winner;
  let nameA = "???";
  let nameB = "???";
  if (voted) {
    const mRows = await db.select().from(models).where(inArray(models.id, [battle.modelAId, battle.modelBId]));
    const byM = new Map(mRows.map((m) => [m.id, m.name]));
    nameA = byM.get(battle.modelAId) ?? battle.modelAId;
    nameB = byM.get(battle.modelBId) ?? battle.modelBId;
    const aIds = [battle.assistantAId, battle.assistantBId].filter(Boolean) as string[];
    if (aIds.length) {
      const aRows = await db.select().from(assistants).where(inArray(assistants.id, aIds));
      const byA = new Map(aRows.map((a) => [a.id, `${a.avatar} ${a.name}`]));
      if (battle.assistantAId && byA.get(battle.assistantAId)) nameA = `${byA.get(battle.assistantAId)} (${nameA})`;
      if (battle.assistantBId && byA.get(battle.assistantBId)) nameB = `${byA.get(battle.assistantBId)} (${nameB})`;
    }
  }

  // Group messages into turns
  const turns: { prompt: string; a?: string; b?: string }[] = [];
  for (const m of msgs) {
    if (m.role === "user") turns.push({ prompt: m.content });
    else if (turns.length) {
      const last = turns[turns.length - 1];
      if (m.role === "a") last.a = m.content;
      else last.b = m.content;
    }
  }
  if (turns.length === 0) {
    turns.push({ prompt: battle.prompt, a: battle.responseA, b: battle.responseB });
  }

  const outcome =
    battle.winner === "a" ? `🏆 ${nameA} won` : battle.winner === "b" ? `🏆 ${nameB} won` : battle.winner === "tie" ? "🤝 Tie" : battle.winner === "both-bad" ? "👎 Both bad" : "🎭 Awaiting vote";

  return Response.json({ battle, turns, outcome, nameA, nameB, voted });
}
