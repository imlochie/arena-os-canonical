import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { battles, battleMessages } from "@/db/schema";
import { prepareExecutionSession } from "@/lib/executionSession";
import { advanceSessionStage, transitionSession, transitionSessionInTransaction } from "@/lib/sessionLifecycle";
import { allocateArenaWorkforce, persistSessionWorkforceAssignments } from "@/lib/workforceRuntime";
import { desc } from "drizzle-orm";
import { executeWorker } from "@/lib/workerExecutor";
import { assignSides, resolveFighters } from "@/lib/battleSetup";
import { isEphemeralBody, logPrivacyEvent, sealReveal } from "@/lib/privacy";
import { requiresLocalExecution } from "@/lib/executionPolicy";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { apiErrorResponse, serializeApiError, validationError } from "@/lib/apiErrors";
import { runtimeError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// GET → recent battles (history)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const category = url.searchParams.get("category");
  try {
    const rows = await db.select().from(battles).orderBy(desc(battles.createdAt)).limit(100);
    const filtered = category ? rows.filter((r) => r.category === category) : rows;
    // Hide model identities for unvoted battles (blind arena rule)
    const masked = filtered.slice(0, limit).map((r) =>
      r.winner ? r : { ...r, modelAId: "???", modelBId: "???", assistantAId: null, assistantBId: null }
    );
    return Response.json({ battles: masked });
  } catch (e) {
    console.error(e);
    return Response.json({ battles: [] });
  }
}

// POST → run a new blind battle (non-streaming; /api/battles/stream streams)
// Privacy: localOnly → zero-egress on-device generation; ephemeral →
// nothing is persisted (sealed reveal token keeps the battle blind).
export async function POST(req: Request) {
  let sessionId: string | null = null;
  try {
    await ensureSeeded();
    const body = await req.json();
    const prompt: string = (body.prompt ?? "").toString().trim();
    const keys = body.keys;
    const imageSize: string | undefined = body.imageSize;
    const executionConfig = parseExecutionConfig(body);
    const executionMode = executionConfig.mode;
    const localOnly = requiresLocalExecution(executionMode);
    const ephemeral = isEphemeralBody(body);

    if (!prompt) return validationError("INVALID_REQUEST", "Prompt is required.");
    if (prompt.length > 4000) return validationError("INVALID_REQUEST", "Prompt must be 4,000 characters or fewer.");

    const projectId = body.projectId ? String(body.projectId) : null;
    const isImage = body.category === "image";
    const explicit = body.fighterA?.id || body.fighterB?.id || body.modelAId || body.modelBId;
    const outputCapability = isImage ? "image_generation" : "text_generation";
    const initialWorkforce = !explicit ? await allocateArenaWorkforce({}, executionMode, outputCapability) : null;
    const setup = await resolveFighters(initialWorkforce ? {
      ...body,
      modelAId: initialWorkforce[0].modelId,
      modelBId: initialWorkforce[1].modelId,
      workforceAllocated: true,
    } : body);
    const workforce = initialWorkforce ?? await allocateArenaWorkforce(
      { a: setup.a.modelId, b: setup.b.modelId }, executionMode, outputCapability
    );
    if (workforce.length) {
      setup.a.sys += `\n\n${workforce[0].promptFragment}`;
      setup.b.sys += `\n\n${workforce[1].promptFragment}`;
    }
    const { left, right, swapped } = assignSides(setup);
    const leftAssignment = workforce[swapped ? 1 : 0];
    const rightAssignment = workforce[swapped ? 0 : 1];
    const genKeys = localOnly ? undefined : keys;
    if (!ephemeral) {
      sessionId = await prepareExecutionSession({
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
        mode: "arena",
        executionMode,
        maxExecutionAttempts: executionConfig.maxExecutionAttempts,
        fallbackPolicy: executionConfig.fallbackPolicy,
        projectId,
        title: `⚔️ Arena — ${prompt.slice(0, 80)}`,
        intent: "Compare competing responses",
        content: prompt,
        metadata: { category: setup.category, executionMode },
      });
      if (workforce.length) await persistSessionWorkforceAssignments(sessionId, workforce);
      await advanceSessionStage(sessionId, "generating_responses", { expectedPreviousStage: null });
    }
    const ctx = await getProjectContext(projectId);
    const effectivePrompt = withProjectContext(prompt, ctx);

    const [rA, rB] = await Promise.all([
      executeWorker({ sessionId, assignment: leftAssignment, messages: [{ role: "user", content: effectivePrompt }], system: left.sys, keys: genKeys, imageSize, category: setup.category, outputContract: isImage ? "image" : "text" }),
      executeWorker({ sessionId, assignment: rightAssignment, messages: [{ role: "user", content: effectivePrompt }], system: right.sys, keys: genKeys, imageSize, category: setup.category, outputContract: isImage ? "image" : "text" }),
    ]);

    if (ephemeral) {
      // Nothing touches the database. Blindness preserved via sealed token.
      const revealToken = sealReveal({
        a: left.modelId,
        b: right.modelId,
        aa: left.assistantId ?? null,
        bb: right.assistantId ?? null,
        exp: Date.now() + 1000 * 60 * 60 * 6,
      });
      await logPrivacyEvent("ephemeral_battle", `category=${setup.category} localOnly=${localOnly}`);
      return Response.json({
        battle: {
          id: `ephemeral-${Date.now().toString(36)}`,
          ephemeral: true,
          revealToken,
          prompt,
          category: setup.category,
          responseA: rA.text,
          responseB: rB.text,
          latencyA: rA.ms,
          latencyB: rB.ms,
          createdAt: new Date().toISOString(),
          viaA: rA.via,
          viaB: rB.via,
          sampling: setup.sampling,
          positionRandomized: true,
          localOnly,
        },
      });
    }

    if (!sessionId) throw new Error("Arena session missing");
    const executionSessionId = sessionId;
    let battle;
    try {
      battle = await db.transaction(async (tx) => {
        const [row] = await tx.insert(battles).values({
        prompt, category: setup.category, modelAId: left.modelId, modelBId: right.modelId,
        assistantAId: left.assistantId ?? null, assistantBId: right.assistantId ?? null,
        responseA: rA.text, responseB: rB.text, latencyA: rA.ms, latencyB: rB.ms,
        projectId, sessionId: executionSessionId,
      }).returning();
      await tx.insert(battleMessages).values([
        { battleId: row.id, role: "user", content: prompt },
        { battleId: row.id, role: "a", content: rA.text },
        { battleId: row.id, role: "b", content: rB.text },
      ]);
      if (projectId) await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
      await transitionSessionInTransaction(tx, executionSessionId, "completed", { payload: { battleId: row.id } });
        return row;
      });
    } catch (error) {
      throw runtimeError({
        code: "PERSISTENCE_FAILED",
        message: "Arena completed, but its execution could not be persisted.",
        stage: "persistence",
        retryable: true,
        sessionId: executionSessionId,
        cause: error,
      });
    }

    // Return blind: do NOT reveal model ids until vote
    return Response.json({
      battle: {
        id: battle.id,
        sessionId: battle.sessionId,
        prompt: battle.prompt,
        category: battle.category,
        responseA: battle.responseA,
        responseB: battle.responseB,
        latencyA: battle.latencyA,
        latencyB: battle.latencyB,
        createdAt: battle.createdAt,
        viaA: rA.via,
        viaB: rB.via,
        sampling: setup.sampling,
        positionRandomized: true,
        localOnly,
      },
    });
  } catch (e) {
    console.error("battle error", e);
    const fallback = {
      code: "ARENA_EXECUTION_FAILED",
      message: "Arena execution failed.",
      stage: "execution" as const,
      retryable: true,
      sessionId,
    };
    const failure = serializeApiError(e, fallback);
    if (sessionId) await transitionSession(sessionId, "failed", {
      errorCode: failure.code,
      errorMessage: failure.message,
      payload: { retryable: failure.retryable, executionId: failure.executionId },
    }).catch(() => {});
    return apiErrorResponse(e, fallback);
  }
}
