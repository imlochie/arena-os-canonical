import { parseExecutionConfig } from "@/lib/executionConfig";
import { db } from "@/db";
import { collabs, collabContributions } from "@/db/schema";
import { desc } from "drizzle-orm";
import { executeWorker } from "@/lib/workerExecutor";
import {
  getStrategy,
  randomCollaborators,
  resolveCollaborator,
  type Collaborator,
  type CollaboratorInput,
} from "@/lib/collab";
import { getModel } from "@/lib/models";
import { isEphemeralBody, logPrivacyEvent } from "@/lib/privacy";
import { requiresLocalExecution } from "@/lib/executionPolicy";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prepareExecutionSession } from "@/lib/executionSession";
import { advanceSessionStage, transitionSession, transitionSessionInTransaction } from "@/lib/sessionLifecycle";
import { allocateCollabWorkforce, persistSessionWorkforceAssignments } from "@/lib/workforceRuntime";
import { apiErrorResponse, serializeApiError, validationError } from "@/lib/apiErrors";
import { runtimeError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  try {
    const rows = await db.select().from(collabs).orderBy(desc(collabs.createdAt)).limit(limit);
    return Response.json({ collabs: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ collabs: [] });
  }
}

export async function POST(req: Request) {
  let sessionId: string | null = null;
  try {
    await ensureSeeded();
    const body = await req.json();
    const challenge: string = (body.challenge ?? "").toString().trim();
    const category: string = (body.category ?? "general").toString();
    const strategyId: string = (body.strategy ?? "council").toString();
    const synthesisModelRaw: string = (body.synthesisModel ?? "auto").toString();
    const keys = body.keys;
    const executionConfig = parseExecutionConfig(body);
    const executionMode = executionConfig.mode;
    const localOnly = requiresLocalExecution(executionMode);
    const ephemeral = isEphemeralBody(body);
    const genKeys = localOnly ? undefined : keys;

    if (!challenge) return validationError("INVALID_REQUEST", "Challenge is required.");
    if (challenge.length > 6000) return validationError("INVALID_REQUEST", "Challenge must be 6,000 characters or fewer.");

    const strategy = getStrategy(strategyId);
    const synthesisConstraint = synthesisModelRaw === "auto" ? undefined : (() => {
      const model = getModel(synthesisModelRaw);
      return model.kind === "text" ? model.id : undefined;
    })();

    // Resolve 2–4 collaborators
    let inputs: CollaboratorInput[] = Array.isArray(body.collaborators) ? body.collaborators : [];
    if (inputs.length < 2) {
      const defaults = await allocateCollabWorkforce(
        strategy.id, strategy.roles.slice(0, 3), [undefined, undefined, undefined], synthesisConstraint, executionMode
      );
      inputs = defaults.filter((a) => a.slot.startsWith("collaborator_")).map((a) => ({ type: "model", id: a.modelId }));
    }
    inputs = inputs.slice(0, 4);
    const resolved: Collaborator[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const role = strategy.roles[i % strategy.roles.length];
      const c = await resolveCollaborator(inputs[i] ?? {}, role);
      if (c) resolved.push(c);
    }
    // Top up with randoms if some failed
    if (resolved.length < 2) {
      for (const rin of randomCollaborators(3)) {
        if (resolved.length >= 3) break;
        if (resolved.some((r) => r.modelId === rin.id)) continue;
        const c = await resolveCollaborator(rin, strategy.roles[resolved.length % strategy.roles.length]);
        if (c) resolved.push(c);
      }
    }
    if (resolved.length < 2) return validationError("NO_ELIGIBLE_WORKER", "Could not resolve enough collaborators.", 422, "selection");

    const workforce = await allocateCollabWorkforce(
      strategy.id, resolved.map((c) => c.role), resolved.map((c) => c.modelId), synthesisConstraint, executionMode
    );
    const synthesisModel = workforce.find((assignment) => assignment.slot === "synthesis")!.modelId;

    const projectId = body.projectId ? String(body.projectId) : null;
    const ctx = await getProjectContext(projectId);
    const effectiveChallenge = withProjectContext(challenge, ctx);
    const started = Date.now();
    if (!ephemeral) {
      sessionId = await prepareExecutionSession({
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
        mode: "collab", executionMode, projectId, title: `🧠 Collab — ${challenge.slice(0, 80)}`,
        intent: strategy.name, content: challenge, metadata: { category, strategy: strategy.id, executionMode },
      });
      await persistSessionWorkforceAssignments(sessionId, workforce);
      await advanceSessionStage(sessionId, "drafting", { expectedPreviousStage: null });
    }

    // ---- Round 1: parallel assigned-worker drafts ----
    const contributorAssignments = resolved.map((_, index) =>
      workforce.find((assignment) => assignment.slot === `collaborator_${index + 1}`)!
    );
    const synthesisAssignment = workforce.find((assignment) => assignment.slot === "synthesis")!;
    const drafts = await Promise.all(
      resolved.map((c, index) => executeWorker({
        sessionId,
        assignment: contributorAssignments[index],
        messages: [{ role: "user", content: effectiveChallenge }],
        system: `${c.sys}\n\nSTRATEGY: ${strategy.name}. ${strategy.contributorInstruction}`,
        keys: genKeys,
      }))
    );

    let critiques: typeof drafts = [];
    if (strategy.rounds === 2) {
      if (sessionId) await advanceSessionStage(sessionId, "critiquing", { expectedPreviousStage: "drafting" });
      const digest = resolved
        .map((c, i) => `--- ${c.emoji} ${c.label} (${c.role}) ---\n${drafts[i].text.slice(0, 1800)}`)
        .join("\n\n");
      critiques = await Promise.all(
        resolved.map((c, index) => executeWorker({
          sessionId,
          assignment: contributorAssignments[index],
          messages: [{
            role: "user",
            content: `ORIGINAL CHALLENGE:\n${challenge.slice(0, 2500)}\n\nALL ROUND-1 DRAFTS:\n${digest.slice(0, 8000)}\n\nYou are ${c.label} (${c.role}). Critique the OTHER drafts honestly, steelman the strongest rival point, then sharpen YOUR position in 3-6 sentences. Markdown.`,
          }],
          system: c.sys,
          temperature: 0.7,
          keys: genKeys,
        }))
      );
    }

    if (sessionId) await advanceSessionStage(sessionId, "synthesizing", {
      expectedPreviousStage: strategy.rounds === 2 ? "critiquing" : "drafting"
    });
    const material = strategy.rounds === 2
      ? resolved.map((c, i) =>
          `--- ${c.emoji} ${c.label} (${c.role}) — DRAFT ---\n${drafts[i].text.slice(0, 2200)}\n\n--- ${c.label} — CRITIQUE ---\n${critiques[i].text.slice(0, 1400)}`
        ).join("\n\n")
      : resolved.map((c, i) =>
          `--- ${c.emoji} ${c.label} (${c.role}) ---\n${drafts[i].text.slice(0, 2600)}`
        ).join("\n\n");
    const synth = await executeWorker({
      sessionId,
      assignment: synthesisAssignment,
      messages: [{
        role: "user",
        content: `CHALLENGE (${strategy.name}):\n${challenge.slice(0, 3000)}\n\nCOLLABORATOR MATERIAL:\n${material.slice(0, 11000)}`,
      }],
      system: strategy.synthesisInstruction,
      temperature: 0.5,
      keys: genKeys,
    });

    const collabMeta = {
      challenge,
      category,
      strategy: strategy.id,
      collaborators: JSON.stringify(
        resolved.map((c) => ({
          type: c.type,
          id: c.id,
          label: c.label,
          emoji: c.emoji,
          modelId: c.modelId,
          assistantId: c.assistantId ?? null,
          role: c.role,
        }))
      ),
      synthesisModel,
      synthesis: synth.text,
      rounds: strategy.rounds,
      projectId,
      sessionId,
    };

    const contribsBase = (collabId: string) => {
      const list: (typeof collabContributions.$inferInsert)[] = [];
      resolved.forEach((c, i) => {
        list.push({
          collabId,
          round: 1,
          contribIndex: i,
          kind: "draft",
          label: `${c.emoji} ${c.label} · ${c.role}`,
          modelId: c.modelId,
          assistantId: c.assistantId ?? null,
          content: drafts[i].text,
          latencyMs: drafts[i].ms,
        });
        if (strategy.rounds === 2) {
          list.push({
            collabId,
            round: 2,
            contribIndex: i,
            kind: "critique",
            label: `${c.emoji} ${c.label} · critique`,
            modelId: c.modelId,
            assistantId: c.assistantId ?? null,
            content: critiques[i].text,
            latencyMs: critiques[i].ms,
          });
        }
      });
      list.push({
        collabId,
        round: strategy.rounds,
        contribIndex: -1,
        kind: "synthesis",
        label: `💎 Synthesis · ${getModel(synthesisModel).name}`,
        modelId: synthesisModel,
        content: synth.text,
        latencyMs: synth.ms,
      });
      return list;
    };

    if (ephemeral) {
      await logPrivacyEvent("ephemeral_collab", `strategy=${strategy.id} localOnly=${localOnly}`);
      const fakeId = `ephemeral-${Date.now().toString(36)}`;
      return Response.json({
        collab: { ...collabMeta, id: fakeId, ephemeral: true, bestContributor: null, createdAt: new Date().toISOString(), localOnly },
        contributions: contribsBase(fakeId).map((c, i) => ({ ...c, id: `eph-${i}` })),
        ms: Date.now() - started,
        localOnly,
      });
    }

    if (!sessionId) throw new Error("Collab session missing");
    let persisted;
    try {
      persisted = await db.transaction(async (tx) => {
        const [row] = await tx.insert(collabs).values(collabMeta).returning();
      const contribs = contribsBase(row.id);
      await tx.insert(collabContributions).values(contribs);
      if (projectId) await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
      await transitionSessionInTransaction(tx, sessionId!, "completed", { payload: { collabId: row.id } });
        return { row, contribs };
      });
    } catch (error) {
      throw runtimeError({
        code: "PERSISTENCE_FAILED",
        message: "Collab completed, but its execution could not be persisted.",
        stage: "persistence",
        retryable: true,
        sessionId,
        cause: error,
      });
    }
    const { row, contribs } = persisted;

    return Response.json({
      collab: { ...row, localOnly },
      contributions: contribs.map((c, i) => ({ ...c, id: `new-${i}` })),
      ms: Date.now() - started,
      localOnly,
    });
  } catch (e) {
    console.error("collab error", e);
    const fallback = {
      code: "COLLAB_EXECUTION_FAILED",
      message: "Collab execution failed.",
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
