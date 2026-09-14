import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { battles, battleMessages, cognitiveSessionAssignments, cognitiveSessions } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { executeWorker } from "@/lib/workerExecutor";
import { storedExecutionMode } from "@/lib/executionPolicy";
import { allocateWorkforce, persistSessionWorkforceAssignments } from "@/lib/workforceRuntime";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

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
    if (!battle) return validationError("SESSION_NOT_FOUND", "Arena execution not found.", 404, "session");
    const [session] = battle.sessionId
      ? await db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, battle.sessionId)).limit(1)
      : [];
    const executionMode = storedExecutionMode(session?.executionMode, session?.metadata) ?? parseExecutionConfig(body).mode;

    if (!battle.sessionId || !session) {
      return validationError("INVALID_SESSION_STATE", "Arena session is unavailable.", 409, "session");
    }
    let [judgeAssignment] = await db.select().from(cognitiveSessionAssignments).where(and(
      eq(cognitiveSessionAssignments.sessionId, battle.sessionId),
      eq(cognitiveSessionAssignments.slot, "judge")
    )).limit(1);
    if (!judgeAssignment) {
      const [allocated] = await allocateWorkforce([{
        slot: "judge", requestedRole: "Arena Impartial Judge", workforceRoleId: "critic",
        requiredCapabilities: ["text_generation"],
      }], executionMode);
      const persisted = await persistSessionWorkforceAssignments(battle.sessionId, [allocated]);
      judgeAssignment = persisted.assignments[0];
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

    const result = await executeWorker({
      sessionId: battle.sessionId, assignment: judgeAssignment,
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
    return apiErrorResponse(e, { code: "ARENA_JUDGE_FAILED", message: "Arena judge execution failed.", stage: "execution", retryable: true });
  }
}
