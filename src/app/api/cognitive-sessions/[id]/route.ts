import { db } from "@/db";
import { battles, collabContributions, collabs, cognitiveSessionAssignments, cognitiveSessionEvents, cognitiveSessionInputs, cognitiveSessions, councilArtifacts, councilRuns, handoffs, workerExecutions } from "@/db/schema";
import { asc, eq, or } from "drizzle-orm";
import { parseCouncilSynthesis } from "@/lib/councilSynthesis";
import { parsePersistedCapabilityMatch } from "@/lib/workforceRuntime";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [session] = await db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, id)).limit(1);
    if (!session) {
      return validationError("SESSION_NOT_FOUND", "Cognitive session not found.", 404, "session");
    }
    const [events, assignmentRows, inputs, handoffRows, executionRows] = await Promise.all([
      db.select().from(cognitiveSessionEvents)
        .where(eq(cognitiveSessionEvents.sessionId, id))
        .orderBy(asc(cognitiveSessionEvents.sequence)),
      db.select().from(cognitiveSessionAssignments)
        .where(eq(cognitiveSessionAssignments.sessionId, id))
        .orderBy(asc(cognitiveSessionAssignments.createdAt)),
      db.select().from(cognitiveSessionInputs)
        .where(eq(cognitiveSessionInputs.sessionId, id))
        .orderBy(asc(cognitiveSessionInputs.createdAt)),
      db.select().from(handoffs).where(or(
        eq(handoffs.sourceSessionId, id),
        eq(handoffs.targetSessionId, id)
      )).orderBy(asc(handoffs.createdAt)),
      db.select().from(workerExecutions).where(eq(workerExecutions.sessionId, id))
        .orderBy(asc(workerExecutions.startedAt)),
    ]);
    const assignments = assignmentRows.map((assignment) => ({
      ...assignment,
      capabilityMatch: parsePersistedCapabilityMatch(assignment.capabilityMatch),
      capabilitiesConsidered: parsePersistedCapabilityMatch(assignment.capabilitiesConsidered),
    }));

    let run = null;
    let artifact = null;
    let arenaExecution = null;
    let collabExecution = null;
    let contributions: typeof collabContributions.$inferSelect[] = [];
    if (session.mode === "council") {
      [run] = await db.select().from(councilRuns).where(eq(councilRuns.sessionId, session.id)).limit(1);
      if (run) [artifact] = await db.select().from(councilArtifacts).where(eq(councilArtifacts.runId, run.id)).limit(1);
    } else if (session.mode === "arena") {
      [arenaExecution] = await db.select().from(battles).where(eq(battles.sessionId, session.id)).limit(1);
    } else if (session.mode === "collab") {
      [collabExecution] = await db.select().from(collabs).where(eq(collabs.sessionId, session.id)).limit(1);
      if (collabExecution) contributions = await db.select().from(collabContributions)
        .where(eq(collabContributions.collabId, collabExecution.id)).orderBy(asc(collabContributions.createdAt));
    }

    return Response.json({
      session: {
        ...session,
        metadata: safelyParsePayload(session.metadata),
        lifecycleState: session.status === "running" && session.currentStage ? session.currentStage : session.status,
      },
      inputs,
      assignments,
      workerExecutions: executionRows.map((execution) => ({
        ...execution,
        metadata: safelyParsePayload(execution.metadata),
      })),
      executionSummary: assignmentRows.map((initial) => {
        if (initial.assignmentSequence !== 1) return null;
        const chain = assignmentRows.filter((item) => item.slot === initial.slot)
          .sort((a, b) => a.assignmentSequence - b.assignmentSequence);
        const active = chain.find((item) => item.status === "active") ?? chain[chain.length - 1];
        const completed = [...executionRows].reverse().find((item) =>
          item.status === "completed" && chain.some((assignment) => assignment.id === item.assignmentId)
        );
        return {
          slot: initial.slot,
          initialWorker: { assignmentId: initial.id, workerId: initial.workerId, modelId: initial.modelId },
          selectedWorker: { assignmentId: active.id, workerId: active.workerId, modelId: active.modelId },
          actualSuccessfulWorker: completed ? {
            assignmentId: completed.assignmentId,
            provider: completed.actualProvider,
            modelId: completed.actualModelId,
            executionId: completed.id,
          } : null,
          attemptHistory: executionRows.filter((item) => chain.some((assignment) => assignment.id === item.assignmentId))
            .map((item) => item.id),
        };
      }).filter(Boolean),
      handoffs: handoffRows.map((handoff) => ({
        ...handoff,
        direction: handoff.sourceSessionId === id ? "outgoing" : "incoming",
        payload: safelyParsePayload(handoff.payload),
        metadata: safelyParsePayload(handoff.metadata),
      })),
      events: events.map((event) => ({
        ...event,
        payload: safelyParsePayload(event.payload),
      })),
      run: run ? {
        ...run,
        synthesisData: run.structuredSynthesis ? parseCouncilSynthesis(run.structuredSynthesis) : null,
      } : null,
      artifact: artifact ?? null,
      arenaExecution,
      collabExecution: collabExecution ? { ...collabExecution, contributions } : null,
      terminal: session.status === "completed" || session.status === "failed",
    });
  } catch (error) {
    console.error("cognitive session detail GET error", error);
    return apiErrorResponse(error, {
      code: "SESSION_READ_FAILED", message: "Unable to load cognitive session.", stage: "persistence",
    });
  }
}

function safelyParsePayload(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
