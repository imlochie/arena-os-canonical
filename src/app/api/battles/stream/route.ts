import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { battles, battleMessages, projects } from "@/db/schema";
import { prepareExecutionSession } from "@/lib/executionSession";
import { advanceSessionStage, transitionSession, transitionSessionInTransaction } from "@/lib/sessionLifecycle";
import { allocateArenaWorkforce, persistSessionWorkforceAssignments } from "@/lib/workforceRuntime";
import { requiresLocalExecution } from "@/lib/executionPolicy";
import { eq } from "drizzle-orm";
import { assignSides, resolveFighters } from "@/lib/battleSetup";
import { executeWorkerStream } from "@/lib/workerExecutor";
import type { WorkforceAssignment } from "@/lib/workforceResolver";
import { apiErrorResponse, serializeApiError, validationError } from "@/lib/apiErrors";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 90;
export const runtime = "nodejs";

// POST → SSE streaming battle. Events:
// {type:"meta", battleId, sampling} · {type:"delta", side:"a"|"b", delta}
// {type:"done", side, ms} · {type:"battle", battle} · {type:"error", error}
export async function POST(req: Request) {
  await ensureSeeded();
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return validationError("INVALID_REQUEST", "Request body must be valid JSON.");
  }
  const prompt: string = (body.prompt ?? "").toString().trim();
  const keys = body.keys;
  let executionMode;
  try {
    executionMode = parseExecutionConfig(body).mode;
  } catch (error) {
    return apiErrorResponse(error, {
      code: "POLICY_VIOLATION", message: "Invalid execution policy.", stage: "policy", status: 422,
    });
  }
  const localOnly = requiresLocalExecution(executionMode);
  const genKeys = localOnly ? undefined : keys;
  if (!prompt) return validationError("INVALID_REQUEST", "Prompt is required.");
  if (prompt.length > 4000) return validationError("INVALID_REQUEST", "Prompt must be 4,000 characters or fewer.");

  let setup;
  let workforce: WorkforceAssignment[] = [];
  let isImage = false;
  let sessionId: string | null = null;
  const projectId = body.projectId ? String(body.projectId) : null;
  try {
    const explicit = body.fighterA?.id || body.fighterB?.id || body.modelAId || body.modelBId;
    isImage = body.category === "image";
    const outputCapability = isImage ? "image_generation" : "text_generation";
    const initialWorkforce = !explicit ? await allocateArenaWorkforce({}, executionMode, outputCapability) : null;
    setup = await resolveFighters(initialWorkforce ? {
      ...body, modelAId: initialWorkforce[0].modelId, modelBId: initialWorkforce[1].modelId, workforceAllocated: true,
    } : body);
    workforce = initialWorkforce ?? await allocateArenaWorkforce(
      { a: setup.a.modelId, b: setup.b.modelId }, executionMode, outputCapability
    );
    if (workforce.length) {
      setup.a.sys += `\n\n${workforce[0].promptFragment}`;
      setup.b.sys += `\n\n${workforce[1].promptFragment}`;
    }
    sessionId = await prepareExecutionSession({
      sessionId: body.sessionId ? String(body.sessionId) : undefined, mode: "arena", executionMode, projectId,
      title: `⚔️ Arena — ${prompt.slice(0, 80)}`, intent: "Compare competing responses", content: prompt,
      metadata: { category: setup.category, executionMode },
    });
    if (workforce.length) await persistSessionWorkforceAssignments(sessionId, workforce);
    await advanceSessionStage(sessionId, "generating_responses", { expectedPreviousStage: null });
  } catch (e) {
    console.error(e);
    if (sessionId) await transitionSession(sessionId, "failed", { errorCode: "ARENA_SETUP_FAILED", errorMessage: "Arena setup failed." }).catch(() => {});
    return apiErrorResponse(e, {
      code: "ARENA_SETUP_FAILED", message: "Arena setup failed.", stage: "selection", sessionId,
    });
  }
  const { left, right, swapped } = assignSides(setup);
  const leftAssignment = workforce[swapped ? 1 : 0];
  const rightAssignment = workforce[swapped ? 0 : 1];

  let battle;
  try {
    battle = await db.transaction(async (tx) => {
      const [row] = await tx.insert(battles).values({
        prompt, category: setup.category, modelAId: left.modelId, modelBId: right.modelId,
        assistantAId: left.assistantId ?? null, assistantBId: right.assistantId ?? null,
        responseA: "", responseB: "", latencyA: 0, latencyB: 0, projectId, sessionId,
      }).returning();
      await tx.insert(battleMessages).values({ battleId: row.id, role: "user", content: prompt });
      return row;
    });
  } catch (error) {
    console.error("battle persistence error", error);
    await transitionSession(sessionId, "failed", {
      errorCode: "ARENA_PERSISTENCE_FAILED", errorMessage: "Arena execution could not be persisted."
    }).catch(() => {});
    return apiErrorResponse(error, {
      code: "ARENA_PERSISTENCE_FAILED", message: "Arena execution could not be persisted.",
      stage: "persistence", retryable: true, sessionId,
    });
  }

  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: any) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send({ type: "meta", battleId: battle.id, sessionId, sampling: setup.sampling, positionRandomized: true });
      let fullA = "";
      let fullB = "";
      try {
        const runSide = async (
          side: "a" | "b",
          assignment: WorkforceAssignment,
          sys: string,
          acc: { t: string }
        ) => {
          const t0 = Date.now();
          const execution = await executeWorkerStream({
            sessionId, assignment,
            messages: [{ role: "user", content: prompt }],
            system: sys,
            keys: genKeys,
            outputContract: isImage ? "image" : "text",
          });
          for await (const chunk of execution.stream) {
            acc.t += chunk;
            send({ type: "delta", side, delta: chunk });
          }
          send({ type: "done", side, ms: Date.now() - t0 });
        };
        const accA = { t: "" };
        const accB = { t: "" };
        await Promise.all([
          runSide("a", leftAssignment, left.sys, accA),
          runSide("b", rightAssignment, right.sys, accB),
        ]);
        fullA = accA.t;
        fullB = accB.t;
        const totalMs = Date.now() - started;
        const final = await db.transaction(async (tx) => {
          const [row] = await tx.update(battles)
            .set({ responseA: fullA, responseB: fullB, latencyA: totalMs, latencyB: totalMs })
            .where(eq(battles.id, battle.id)).returning();
          await tx.insert(battleMessages).values([
            { battleId: battle.id, role: "a", content: fullA },
            { battleId: battle.id, role: "b", content: fullB },
          ]);
          if (projectId) await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
          await transitionSessionInTransaction(tx, sessionId!, "completed", { payload: { battleId: battle.id } });
          return row;
        });
        send({
          type: "battle",
          battle: {
            id: final.id,
            sessionId: final.sessionId,
            prompt: final.prompt,
            category: final.category,
            responseA: fullA,
            responseB: fullB,
            latencyA: totalMs,
            latencyB: totalMs,
            createdAt: final.createdAt,
            sampling: setup.sampling,
            positionRandomized: true,
          },
        });
      } catch (e) {
        console.error("stream error", e);
        // Best-effort persist of partials
        try {
          await db
            .update(battles)
            .set({
              responseA: fullA || "⚠️ Stream interrupted — retry the battle.",
              responseB: fullB || "⚠️ Stream interrupted — retry the battle.",
            })
            .where(eq(battles.id, battle.id));
        } catch {}
        const failure = serializeApiError(e, {
          code: "ARENA_STREAM_FAILED", message: "Arena stream failed.", stage: "execution",
          retryable: true, sessionId,
        });
        await transitionSession(sessionId!, "failed", {
          errorCode: failure.code, errorMessage: failure.message,
          payload: { retryable: failure.retryable, executionId: failure.executionId }
        }).catch(() => {});
        send({ type: "error", error: failure });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
