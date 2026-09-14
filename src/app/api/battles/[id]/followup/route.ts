import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { battles, battleMessages, assistants, cognitiveSessionAssignments, cognitiveSessions } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { type ChatMsg } from "@/lib/ai";
import { executeWorker } from "@/lib/workerExecutor";
import { getModel } from "@/lib/models";
import { requiresLocalExecution, storedExecutionMode } from "@/lib/executionPolicy";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

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
    if (!message) return validationError("INVALID_REQUEST", "Follow-up message is required.");
    if (message.length > 4000) return validationError("INVALID_REQUEST", "Follow-up message must be 4,000 characters or fewer.");

    const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    if (!battle) return validationError("SESSION_NOT_FOUND", "Arena execution not found.", 404, "session");
    if (battle.category === "image") {
      return validationError("INVALID_REQUEST", "Image battles are single-turn.");
    }
    const [session] = battle.sessionId
      ? await db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, battle.sessionId)).limit(1)
      : [];
    const executionMode = storedExecutionMode(session?.executionMode, session?.metadata) ?? parseExecutionConfig(body).mode;
    const localOnly = requiresLocalExecution(executionMode);
    const genKeys = localOnly ? undefined : keys;
    if (!battle.sessionId) return validationError("INVALID_SESSION_STATE", "Arena session assignment is missing.", 409, "session");
    const assignments = await db.select().from(cognitiveSessionAssignments)
      .where(eq(cognitiveSessionAssignments.sessionId, battle.sessionId));
    const assignmentA = assignments.find((assignment) => assignment.modelId === battle.modelAId) ?? assignments[0];
    const assignmentB = assignments.find((assignment) =>
      assignment.modelId === battle.modelBId && assignment.slot !== assignmentA?.slot
    ) ?? assignments.find((assignment) => assignment.slot !== assignmentA?.slot);
    if (!assignmentA || !assignmentB) {
      return validationError("INVALID_SESSION_STATE", "Arena worker assignments are unavailable.", 409, "session");
    }

    const prior = await db
      .select()
      .from(battleMessages)
      .where(eq(battleMessages.battleId, id))
      .orderBy(asc(battleMessages.createdAt))
      .limit(100);
    const userTurns = prior.filter((m) => m.role === "user").length;
    if (userTurns >= MAX_TURNS) {
      return validationError("INVALID_SESSION_STATE", `Turn limit reached (${MAX_TURNS}); cast your vote.`, 409, "session");
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
      executeWorker({ sessionId: battle.sessionId, assignment: assignmentA, messages: buildHistory("a"), system: sysA, keys: genKeys }),
      executeWorker({ sessionId: battle.sessionId, assignment: assignmentB, messages: buildHistory("b"), system: sysB, keys: genKeys }),
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
    return apiErrorResponse(e, { code: "ARENA_FOLLOWUP_FAILED", message: "Arena follow-up failed.", stage: "execution", retryable: true });
  }
}
