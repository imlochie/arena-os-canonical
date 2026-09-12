import { db } from "@/db";
import { battles, battleMessages, assistants } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { generate, type ChatMsg } from "@/lib/ai";
import { getModel } from "@/lib/models";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_TURNS = 10;

// POST → continue a battle with a follow-up message (multi-turn arena)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const message: string = (body.message ?? "").toString().trim();
    const keys = body.keys;
    if (!message) return Response.json({ error: "message required" }, { status: 400 });
    if (message.length > 4000) return Response.json({ error: "message too long" }, { status: 400 });

    const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    if (!battle) return Response.json({ error: "not found" }, { status: 404 });
    if (battle.category === "image") {
      return Response.json({ error: "image battles are single-turn" }, { status: 400 });
    }

    const prior = await db
      .select()
      .from(battleMessages)
      .where(eq(battleMessages.battleId, id))
      .orderBy(asc(battleMessages.createdAt))
      .limit(100);
    const userTurns = prior.filter((m) => m.role === "user").length;
    if (userTurns >= MAX_TURNS) {
      return Response.json({ error: `turn limit reached (${MAX_TURNS}) — cast your vote!` }, { status: 400 });
    }

    // Resolve per-side system prompts (assistant personas persist across turns)
    let sysA = `You are ${getModel(battle.modelAId).name}. Answer helpfully with markdown formatting. Be concise but complete.`;
    let sysB = `You are ${getModel(battle.modelBId).name}. Answer helpfully with markdown formatting. Be concise but complete.`;
    if (battle.assistantAId) {
      const [a] = await db.select().from(assistants).where(eq(assistants.id, battle.assistantAId)).limit(1);
      if (a) sysA = a.systemPrompt;
    }
    if (battle.assistantBId) {
      const [a] = await db.select().from(assistants).where(eq(assistants.id, battle.assistantBId)).limit(1);
      if (a) sysB = a.systemPrompt;
    }

    const buildHistory = (side: "a" | "b"): ChatMsg[] => {
      const h: ChatMsg[] = [];
      for (const m of prior.slice(-18)) {
        if (m.role === "user") h.push({ role: "user", content: m.content });
        else if (m.role === side) h.push({ role: "assistant", content: m.content });
      }
      h.push({ role: "user", content: message });
      return h;
    };

    const [rA, rB] = await Promise.all([
      generate({ modelId: battle.modelAId, messages: buildHistory("a"), system: sysA, keys, localOnly: body.localOnly === true }),
      generate({ modelId: battle.modelBId, messages: buildHistory("b"), system: sysB, keys, localOnly: body.localOnly === true }),
    ]);

    await db.insert(battleMessages).values([
      { battleId: id, role: "user", content: message },
      { battleId: id, role: "a", content: rA.text },
      { battleId: id, role: "b", content: rB.text },
    ]);
    // Keep latest exchange on the battle row (vote context + ratings diagnostics)
    await db
      .update(battles)
      .set({ responseA: rA.text, responseB: rB.text, latencyA: rA.ms, latencyB: rB.ms })
      .where(eq(battles.id, id));

    return Response.json({
      turn: userTurns + 1,
      responseA: rA.text,
      responseB: rB.text,
      latencyA: rA.ms,
      latencyB: rB.ms,
      viaA: rA.via,
      viaB: rB.via,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "followup failed" }, { status: 500 });
  }
}
