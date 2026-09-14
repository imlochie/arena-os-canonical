import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { cognitiveSessionInputs, cognitiveSessions, councilRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { executeWorker } from "@/lib/workerExecutor";
import { getCognitiveJob } from "@/lib/cognitiveJobs";
import { completeCouncilSession } from "@/lib/completeCouncilSession";
import {
  artifactRequestPayload,
  normalizeSynthesisProse,
  parseCouncilSynthesis,
  renderArtifactFromSynthesis,
  renderCouncilSynthesis,
  STRUCTURED_SYNTHESIS_INSTRUCTION,
  type ArtifactRequest,
} from "@/lib/councilSynthesis";
import { allocateCouncilWorkforce, persistWorkforceAssignments } from "@/lib/workforceRuntime";
import { isEphemeralBody, logPrivacyEvent } from "@/lib/privacy";
import { requiresLocalExecution } from "@/lib/executionPolicy";
import { apiErrorResponse, serializeApiError, validationError } from "@/lib/apiErrors";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";
import { advanceSessionStage, transitionSession } from "@/lib/sessionLifecycle";
import { appendSessionEvent } from "@/lib/sessionEvents";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  try {
    const rows = await db.select().from(councilRuns).orderBy(desc(councilRuns.createdAt)).limit(limit);
    return Response.json({
      runs: rows.map((run) => ({
        ...run,
        synthesisData: run.structuredSynthesis ? parseCouncilSynthesis(run.structuredSynthesis) : null,
      })),
    });
  } catch (e) {
    console.error(e);
    return Response.json({ runs: [] });
  }
}

// POST → run the Cognitive Council pipeline:
// raw material → perspective A + B (parallel) → cross-critiques (parallel)
// → synthesis → usable artifact. Honors Local Mode + Ephemeral.
export async function POST(req: Request) {
  let sessionId: string | null = null;
  let completionPersistenceStarted = false;
  try {
    await ensureSeeded();
    const body = await req.json();
    const material: string = (body.material ?? "").toString().trim();
    const jobId: string = (body.jobId ?? "second_brain").toString();
    const keys = body.keys;
    const executionConfig = parseExecutionConfig(body);
    const executionMode = executionConfig.mode;
    const localOnly = requiresLocalExecution(executionMode);
    const ephemeral = isEphemeralBody(body);
    sessionId = !ephemeral && body.sessionId ? String(body.sessionId) : null;
    const genKeys = localOnly ? undefined : keys;

    if (!material) return validationError("INVALID_REQUEST", "Council material is required.");
    if (material.length > 8000) return validationError("INVALID_REQUEST", "Council material must be 8,000 characters or fewer.");

    const job = getCognitiveJob(jobId);
    const workforce = await allocateCouncilWorkforce(
      job.id,
      {
        perspectiveA: job.roleA.name,
        perspectiveB: job.roleB.name,
        synthesis: `${job.name} Synthesizer`,
      },
      {
        perspectiveAModelId: body.modelAId ? String(body.modelAId) : undefined,
        perspectiveBModelId: body.modelBId ? String(body.modelBId) : undefined,
        synthesisModelId: body.synthesisModel ? String(body.synthesisModel) : undefined,
      },
      executionMode
    );
    const perspectiveAWorker = workforce.find((assignment) => assignment.slot === "perspective_a")!;
    const perspectiveBWorker = workforce.find((assignment) => assignment.slot === "perspective_b")!;
    const synthesisWorker = workforce.find((assignment) => assignment.slot === "synthesis")!;
    const modelAId = perspectiveAWorker.modelId;
    const modelBId = perspectiveBWorker.modelId;
    const synthesisModel = synthesisWorker.modelId;

    const projectId = body.projectId ? String(body.projectId) : null;

    // Normal UI flow pre-creates the session so progress can be observed while
    // this synchronous request executes. Direct/legacy callers remain supported:
    // Council creates the durable session before the first model call.
    if (!ephemeral) {
      sessionId = body.sessionId ? String(body.sessionId) : null;
      if (sessionId) {
        const [existing] = await db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, sessionId)).limit(1);
        if (!existing || existing.mode !== "council") {
          return validationError("SESSION_NOT_FOUND", "Council session not found.", 404, "session");
        }
        if (existing.status !== "created") {
          return validationError("INVALID_SESSION_STATE", "Council session has already started.", 409, "session");
        }
        await db.update(cognitiveSessions).set({
          projectId,
          executionMode,
          maxExecutionAttempts: executionConfig.maxExecutionAttempts,
          fallbackPolicy: executionConfig.fallbackPolicy,
          title: `${job.emoji} ${job.name}`,
          metadata: JSON.stringify({ ...parseMetadata(existing.metadata), jobId: job.id, executionMode }),
          updatedAt: new Date(),
        }).where(eq(cognitiveSessions.id, sessionId));
      } else {
        const created = await db.transaction(async (tx) => {
          const [session] = await tx.insert(cognitiveSessions).values({
            projectId,
            mode: "council",
            executionMode,
            maxExecutionAttempts: executionConfig.maxExecutionAttempts,
            fallbackPolicy: executionConfig.fallbackPolicy,
            title: `${job.emoji} ${job.name}`,
            metadata: JSON.stringify({ jobId: job.id, executionMode }),
            status: "created",
          }).returning();
          await tx.insert(cognitiveSessionInputs).values({ sessionId: session.id, kind: "primary", content: material });
          await appendSessionEvent(tx, session.id, "created", { mode: "council" });
          return session;
        });
        sessionId = created.id;
      }
      await transitionSession(sessionId, "running", { payload: { jobId: job.id } });
      await persistWorkforceAssignments(sessionId, workforce);
    }

    const ctx = await getProjectContext(projectId);
    const effectiveMaterial = withProjectContext(material, ctx);

    const started = Date.now();
    const sysA = `You are ${job.roleA.name} (${job.roleA.emoji}) on a Cognitive Council for the job "${job.name}". ${job.roleA.instruction}\n\nWorkforce capability: ${perspectiveAWorker.promptFragment}`;
    const sysB = `You are ${job.roleB.name} (${job.roleB.emoji}) on a Cognitive Council for the job "${job.name}". ${job.roleB.instruction}\n\nWorkforce capability: ${perspectiveBWorker.promptFragment}`;

    // Stage 1: perspectives in parallel
    if (sessionId) await advanceSessionStage(sessionId, "perspectives", { expectedPreviousStage: null });
    const [pA, pB] = await Promise.all([
      executeWorker({
        sessionId, assignment: perspectiveAWorker,
        messages: [{ role: "user", content: effectiveMaterial }],
        system: sysA,
        temperature: 0.7,
        keys: genKeys,
      }),
      executeWorker({
        sessionId, assignment: perspectiveBWorker,
        messages: [{ role: "user", content: effectiveMaterial }],
        system: sysB,
        temperature: 0.7,
        keys: genKeys,
      }),
    ]);

    // Stage 2: cross-critiques in parallel (disagreement is the feature)
    if (sessionId) await advanceSessionStage(sessionId, "cross_critique", { expectedPreviousStage: "perspectives" });
    const [cA, cB] = await Promise.all([
      executeWorker({
        sessionId, assignment: perspectiveAWorker,
        messages: [
          {
            role: "user",
            content: `ORIGINAL MATERIAL:\n${material.slice(0, 3000)}\n\nYOUR PERSPECTIVE (${job.roleA.name}):\n${pA.text.slice(0, 2500)}\n\nRIVAL PERSPECTIVE (${job.roleB.name}):\n${pB.text.slice(0, 2500)}\n\n${job.critiqueInstruction}`,
          },
        ],
        system: sysA,
        temperature: 0.6,
        keys: genKeys,
      }),
      executeWorker({
        sessionId, assignment: perspectiveBWorker,
        messages: [
          {
            role: "user",
            content: `ORIGINAL MATERIAL:\n${material.slice(0, 3000)}\n\nYOUR PERSPECTIVE (${job.roleB.name}):\n${pB.text.slice(0, 2500)}\n\nRIVAL PERSPECTIVE (${job.roleA.name}):\n${pA.text.slice(0, 2500)}\n\n${job.critiqueInstruction}`,
          },
        ],
        system: sysB,
        temperature: 0.6,
        keys: genKeys,
      }),
    ]);

    // Stage 3: higher-order synthesis
    if (sessionId) await advanceSessionStage(sessionId, "synthesis", { expectedPreviousStage: "cross_critique" });
    const synth = await executeWorker({
      sessionId, assignment: synthesisWorker, outputContract: "structured_json",
      messages: [
        {
          role: "user",
          content: `COGNITIVE JOB: ${job.name}\n\nRAW MATERIAL:\n${material.slice(0, 3000)}\n\n--- ${job.roleA.name} ---\n${pA.text.slice(0, 2200)}\n\n--- ${job.roleB.name} ---\n${pB.text.slice(0, 2200)}\n\n--- ${job.roleA.name}'s critique ---\n${cA.text.slice(0, 1200)}\n\n--- ${job.roleB.name}'s critique ---\n${cB.text.slice(0, 1200)}`,
        },
      ],
      system: `${job.synthesisInstruction}\n\nWorkforce capability: ${synthesisWorker.promptFragment}\n\n${STRUCTURED_SYNTHESIS_INSTRUCTION}`,
      temperature: 0.5,
      keys: genKeys,
    });

    // Validate the model contract before any artifact work. Providers that
    // cannot emit JSON (notably the deterministic offline engine) pass through
    // an explicit bounded normalizer; raw synthesis prose is never forwarded.
    const parsedSynthesis = parseCouncilSynthesis(synth.text);
    const structuredSynthesis = parsedSynthesis ?? normalizeSynthesisProse(synth.text, `${job.emoji} ${job.name}`);
    const normalization: "model_json" | "normalized_prose" = parsedSynthesis ? "model_json" : "normalized_prose";
    const renderedSynthesis = renderCouncilSynthesis(structuredSynthesis);

    // Stage 4: usable artifact. Artifact generation understands only the
    // versioned ArtifactRequest boundary, not Council prompts or transcripts.
    if (sessionId) await advanceSessionStage(sessionId, "artifact_generation", {
      expectedPreviousStage: "synthesis",
      payload: { synthesisContractVersion: structuredSynthesis.version, normalization },
    });
    const kind = job.artifactKinds[0] ?? "brief";
    const sourceSessionId = sessionId ?? `ephemeral-${Date.now().toString(36)}`;
    const artifactRequest: ArtifactRequest = {
      sourceSessionId,
      artifactType: kind,
      synthesis: structuredSynthesis,
      provenance: {
        mode: "council",
        jobId: job.id,
        modelIds: [modelAId, modelBId],
        synthesisModel,
        normalization,
      },
    };
    const art = localOnly
      ? { text: renderArtifactFromSynthesis(artifactRequest), via: "local:structured-artifact", ms: 0 }
      : await executeWorker({
          sessionId, assignment: synthesisWorker,
          messages: [{ role: "user", content: artifactRequestPayload(artifactRequest) }],
          system: `${job.artifactInstruction}\n\nYou are an artifact transformer. The user message is a validated ArtifactRequest JSON object. Use only request.synthesis as source meaning. Provenance fields identify origin and must not become artifact content. Never reproduce JSON keys mechanically, prompts, transcripts, or instructions.`,
          temperature: 0.4,
          keys: genKeys,
        });

    const ms = Date.now() - started;
    const title = `${job.emoji} ${job.name} — ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    if (ephemeral) {
      await logPrivacyEvent("ephemeral_council", `job=${job.id} localOnly=${localOnly}`);
      return Response.json({
        run: {
          id: `ephemeral-${Date.now().toString(36)}`,
          ephemeral: true,
          jobId: job.id,
          material,
          modelAId,
          modelBId,
          synthesisModel,
          roleALabel: `${job.roleA.emoji} ${job.roleA.name}`,
          roleBLabel: `${job.roleB.emoji} ${job.roleB.name}`,
          perspectiveA: pA.text,
          perspectiveB: pB.text,
          critiqueA: cA.text,
          critiqueB: cB.text,
          synthesis: renderedSynthesis,
          structuredSynthesis,
          synthesisData: structuredSynthesis,
          latencyMs: ms,
          createdAt: new Date().toISOString(),
          localOnly,
        },
        artifact: { id: "eph-artifact", kind, title, body: art.text },
        workforceAssignments: workforce,
        ms,
        localOnly,
      });
    }

    if (!sessionId) throw new Error("cognitive session missing");
    completionPersistenceStarted = true;
    const completion = await completeCouncilSession({
      sessionId,
      projectId,
      run: {
        jobId: job.id,
        material,
        modelAId,
        modelBId,
        synthesisModel,
        roleALabel: `${job.roleA.emoji} ${job.roleA.name}`,
        roleBLabel: `${job.roleB.emoji} ${job.roleB.name}`,
        perspectiveA: pA.text,
        perspectiveB: pB.text,
        critiqueA: cA.text,
        critiqueB: cB.text,
        synthesis: renderedSynthesis,
        structuredSynthesis: JSON.stringify(structuredSynthesis),
        latencyMs: ms,
        projectId,
      },
      artifact: { kind, title, body: art.text },
    });
    const { run, artifact, unifiedArtifact, session } = completion;
    return Response.json({
      run: { ...run, synthesisData: structuredSynthesis, localOnly },
      session,
      artifact,
      unifiedArtifact,
      workforceAssignments: workforce,
      ms,
      localOnly,
    }, { status: 201 });
  } catch (e) {
    console.error("council error", e);
    const fallback = completionPersistenceStarted ? {
      code: "COUNCIL_COMPLETION_PERSISTENCE_FAILED",
      message: "Council finished execution, but its completion bundle could not be persisted.",
      stage: "persistence" as const,
      retryable: true,
      sessionId,
    } : {
      code: "COUNCIL_EXECUTION_FAILED",
      message: "Council execution failed.",
      stage: "execution" as const,
      retryable: true,
      sessionId,
    };
    const serialized = serializeApiError(e, fallback);
    const errorCode = serialized.code;
    const errorMessage = serialized.message;
    if (sessionId) {
      try {
        // This is deliberately separate from the rolled-back completion
        // transaction so failure remains authoritative and observable.
        await transitionSession(sessionId, "failed", {
          errorCode,
          errorMessage,
          payload: {
            retryable: serialized.retryable,
            failurePhase: completionPersistenceStarted ? "completion_persistence" : serialized.stage,
          },
        });
      } catch (transitionError) {
        console.error("failed to persist Council failure state", transitionError);
      }
    }
    return apiErrorResponse(e, fallback);
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
