import { db } from "@/db";
import { battles, battleMessages } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { localJudge } from "@/lib/localEngine";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const JUDGE_SYSTEM = `You are an impartial AI evaluation judge (MT-Bench / Arena-Hard style).
Compare the two anonymous responses (A and B) to the user's request(s).
Judge ONLY on: correctness, helpfulness, depth, clarity, and instruction-following.
Ignore verbosity unless it adds real value. Penalize confident errors and fluff.
Reply with EXACTLY this structure:
VERDICT: <A or B or TIE or BOTH BAD>
A_SCORE: <1-10>
B_SCORE: <1-10>
REASONING: <2-4 sentences explaining the verdict>`;

// POST → ask an impartial LLM judge for an advisory verdict (does not vote for you)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const keys = body.keys;

    const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    if (!battle) return Response.json({ error: "not found" }, { status: 404 });

    // Local Mode: transparent on-device heuristic rubric, zero egress.
    if (isLocalOnlyBody(body)) {
      const j = localJudge(battle.prompt, battle.responseA ?? "", battle.responseB ?? "");
      const localResult = {
        suggestion: j.suggestion,
        scoreA: j.scoreA,
        scoreB: j.scoreB,
        reasoning: j.reasoning,
        raw: j.reasoning,
        via: "local:heuristic",
        at: new Date().toISOString(),
      };
      await db.update(battles).set({ judgeResult: JSON.stringify(localResult) }).where(eq(battles.id, id));
      return Response.json({ judge: localResult });
    }

    const msgs = await db
      .select()
      .from(battleMessages)
      .where(eq(battleMessages.battleId, id))
      .orderBy(asc(battleMessages.createdAt))
      .limit(60);

    // Build transcript (truncate to keep the judge call cheap)
    const clip = (s: string, n = 2500) => (s.length > n ? s.slice(0, n) + "…[truncated]" : s);
    let transcript = `CATEGORY: ${battle.category}\n\n`;
    if (msgs.length === 0) {
      transcript += `USER:\n${clip(battle.prompt)}\n\nRESPONSE A:\n${clip(battle.responseA)}\n\nRESPONSE B:\n${clip(battle.responseB)}`;
    } else {
      for (const m of msgs) {
        const label = m.role === "user" ? "USER" : m.role === "a" ? "RESPONSE A" : "RESPONSE B";
        transcript += `${label}:\n${clip(m.content, 1800)}\n\n`;
      }
    }

    const result = await generate({
      modelId: "deepseek",
      messages: [{ role: "user", content: transcript.slice(0, 12000) }],
      system: JUDGE_SYSTEM,
      temperature: 0.2,
      keys,
    });

    const raw = result.text;
    const vMatch = raw.match(/VERDICT:\s*(A|B|TIE|BOTH[\s-]?BAD)/i);
    const aMatch = raw.match(/A_SCORE:\s*(\d{1,2})/i);
    const bMatch = raw.match(/B_SCORE:\s*(\d{1,2})/i);
    const rMatch = raw.match(/REASONING:\s*([\s\S]+)/i);
    let suggestion: "a" | "b" | "tie" | "both-bad" | null = null;
    if (vMatch) {
      const v = vMatch[1].toUpperCase().replace(/[\s-]/g, "");
      if (v === "A") suggestion = "a";
      else if (v === "B") suggestion = "b";
      else if (v === "TIE") suggestion = "tie";
      else suggestion = "both-bad";
    }
    const judgeResult = {
      suggestion,
      scoreA: aMatch ? Math.min(10, Number(aMatch[1])) : null,
      scoreB: bMatch ? Math.min(10, Number(bMatch[1])) : null,
      reasoning: (rMatch?.[1] ?? raw).trim().slice(0, 1200),
      raw: raw.slice(0, 2000),
      via: result.via,
      at: new Date().toISOString(),
    };
    await db.update(battles).set({ judgeResult: JSON.stringify(judgeResult) }).where(eq(battles.id, id));
    return Response.json({ judge: judgeResult });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "judge failed" }, { status: 500 });
  }
}
