import { db } from "@/db";
import {
  cognitiveSessionAssignments,
  cognitiveSessions,
  modelCategoryRatings,
  models,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendSessionEvent } from "./sessionEvents";
import {
  enforceExecutionPolicy,
  type ExecutionMode,
} from "./executionPolicy";
import { declaredModelCapabilities, FREE_MODELS } from "./models";
import { enforceWorkerSuitability } from "./workerSuitability";
import { getRole, rolesForJob, STRATEGY_ROLE_MAP } from "./workforce";
import {
  resolveWorkforceAssignments,
  type AvailableWorker,
  type WorkforceAssignment,
  type WorkforceRequest,
} from "./workforceResolver";

export interface CouncilWorkforceConstraints {
  perspectiveAModelId?: string;
  perspectiveBModelId?: string;
  synthesisModelId?: string;
}

export async function allocateCouncilWorkforce(
  jobId: string,
  labels: { perspectiveA: string; perspectiveB: string; synthesis: string },
  constraints: CouncilWorkforceConstraints = {},
  executionMode: ExecutionMode = "online"
): Promise<WorkforceAssignment[]> {
  const roles = rolesForJob(jobId);
  const requests: WorkforceRequest[] = [
    {
      slot: "perspective_a",
      requestedRole: labels.perspectiveA,
      workforceRoleId: roles.a.id,
      pinnedModelId: constraints.perspectiveAModelId,
      requiredCapabilities: ["text_generation"],
    },
    {
      slot: "perspective_b",
      requestedRole: labels.perspectiveB,
      workforceRoleId: roles.b.id,
      pinnedModelId: constraints.perspectiveBModelId,
      requiredCapabilities: ["text_generation"],
    },
    {
      slot: "synthesis",
      requestedRole: labels.synthesis,
      workforceRoleId: roles.synth.id,
      pinnedModelId: constraints.synthesisModelId,
      requiredCapabilities: ["text_generation", "structured_output"],
    },
  ];
  return allocateWorkforce(requests, executionMode);
}

export async function allocateWorkforce(
  requests: WorkforceRequest[],
  executionMode: ExecutionMode = "online",
  options: { distinctWorkers?: boolean } = {}
): Promise<WorkforceAssignment[]> {
  const workers = await availableWorkers();
  const policy = enforceExecutionPolicy(
    workers,
    executionMode,
    requests.flatMap((request) => request.pinnedModelId ? [request.pinnedModelId] : [])
  );
  const suitability = enforceWorkerSuitability(policy.eligibleWorkers, requests);
  return resolveWorkforceAssignments(requests, policy.eligibleWorkers, {
    executionMode,
    eligibilityReasons: policy.eligibilityReasons,
    eligibleWorkersBySlot: suitability.eligibleWorkersBySlot,
    suitabilityReasons: suitability.suitabilityReasons,
    distinctWorkers: options.distinctWorkers,
  });
}

export async function allocateArenaWorkforce(
  constraints: { a?: string; b?: string } = {},
  executionMode: ExecutionMode = "online",
  outputCapability: "text_generation" | "image_generation" = "text_generation"
) {
  return allocateWorkforce([
    { slot: "fighter_a", requestedRole: "Arena Challenger A", workforceRoleId: "strategist", pinnedModelId: constraints.a, requiredCapabilities: [outputCapability] },
    { slot: "fighter_b", requestedRole: "Arena Challenger B", workforceRoleId: "critic", pinnedModelId: constraints.b, requiredCapabilities: [outputCapability] },
  ], executionMode, { distinctWorkers: true });
}

export async function allocateCollabWorkforce(
  strategyId: string,
  requestedRoles: string[],
  pinnedModelIds: Array<string | undefined>,
  synthesisModelId?: string,
  executionMode: ExecutionMode = "online"
) {
  const map = STRATEGY_ROLE_MAP[strategyId] ?? STRATEGY_ROLE_MAP.council;
  const requests: WorkforceRequest[] = requestedRoles.map((requestedRole, index) => ({
    slot: `collaborator_${index + 1}`,
    requestedRole,
    workforceRoleId: map.roles[index % map.roles.length],
    pinnedModelId: pinnedModelIds[index],
    requiredCapabilities: ["text_generation"],
  }));
  requests.push({
    slot: "synthesis",
    requestedRole: "Collab Synthesizer",
    workforceRoleId: getRole(map.synth).id,
    pinnedModelId: synthesisModelId,
    requiredCapabilities: ["text_generation"],
  });
  return allocateWorkforce(requests, executionMode);
}

export async function selectFallbackWorkforceAssignment(input: {
  failedModelId: string;
  failedProvider: string;
  policy: "same_provider" | "eligible_worker";
  request: WorkforceRequest;
  executionMode: ExecutionMode;
}, database: typeof db = db): Promise<WorkforceAssignment> {
  if (input.request.pinnedModelId) {
    throw new Error("Explicitly pinned assignments cannot fall back to another worker.");
  }
  const workers = await availableWorkers(database);
  const policy = enforceExecutionPolicy(workers, input.executionMode);
  const candidates = policy.eligibleWorkers.filter((worker) =>
    worker.modelId !== input.failedModelId &&
    (input.policy !== "same_provider" || worker.provider === input.failedProvider)
  );
  if (!candidates.length) throw new Error(`No fallback worker satisfies ${input.policy} policy.`);
  const suitability = enforceWorkerSuitability(candidates, [input.request]);
  return resolveWorkforceAssignments([input.request], candidates, {
    executionMode: input.executionMode,
    eligibilityReasons: policy.eligibilityReasons,
    eligibleWorkersBySlot: suitability.eligibleWorkersBySlot,
    suitabilityReasons: suitability.suitabilityReasons,
  })[0];
}

export async function persistSessionWorkforceAssignments(
  sessionId: string,
  assignments: WorkforceAssignment[],
  database: typeof db = db
) {
  return database.transaction(async (tx) => {
    const rows = await tx.insert(cognitiveSessionAssignments).values(
      assignments.map((assignment) => ({
        sessionId,
        slot: assignment.slot,
        requestedRole: assignment.requestedRole,
        workforceRoleId: assignment.workforceRoleId,
        workerId: assignment.workerId,
        provider: assignment.provider,
        modelId: assignment.modelId,
        executionMode: assignment.executionMode,
        eligibilityDecision: assignment.eligibilityDecision,
        workerAvailability: assignment.workerAvailability,
        capabilitiesConsidered: JSON.stringify(assignment.capabilitiesConsidered),
        pinnedModelId: assignment.pinnedModelId,
        selectionReason: assignment.selectionReason,
        capabilityMatch: JSON.stringify(assignment.capabilityMatch),
      }))
    ).returning();
    const [session] = await tx.update(cognitiveSessions).set({ updatedAt: new Date() })
      .where(eq(cognitiveSessions.id, sessionId)).returning();
    if (!session) throw new Error("cannot attach Workforce allocation to missing session");
    await appendSessionEvent(tx, sessionId, "workforce_assigned", {
      executionMode: assignments[0]?.executionMode ?? "online",
      assignments: assignments.map(({ slot, workforceRoleId, workerId, modelId, eligibilityDecision, workerAvailability, capabilitiesConsidered }) => ({
        slot, workforceRoleId, workerId, modelId, eligibilityDecision, workerAvailability, capabilitiesConsidered,
      })),
    });
    return { session, assignments: rows };
  });
}

export async function persistWorkforceAssignments(
  sessionId: string,
  assignments: WorkforceAssignment[]
) {
  const bySlot = new Map(assignments.map((assignment) => [assignment.slot, assignment]));
  const a = bySlot.get("perspective_a");
  const b = bySlot.get("perspective_b");
  const synthesis = bySlot.get("synthesis");
  if (!a || !b || !synthesis) throw new Error("Council Workforce allocation is incomplete");

  return persistSessionWorkforceAssignments(sessionId, assignments);
}

export async function availableWorkers(database: typeof db = db): Promise<AvailableWorker[]> {
  const [registry, ratings] = await Promise.all([
    database.select().from(models),
    database.select().from(modelCategoryRatings),
  ]);
  const ratingsByModel = new Map<string, Record<string, number>>();
  for (const rating of ratings) {
    const current = ratingsByModel.get(rating.modelId) ?? {};
    current[rating.category] = rating.elo;
    ratingsByModel.set(rating.modelId, current);
  }
  const registryById = new Map(registry.map((model) => [model.id, model]));
  return FREE_MODELS
    .map((model) => {
      const row = registryById.get(model.id);
      return {
        id: `model:${model.id}`,
        modelId: model.id,
        name: row?.name ?? model.name,
        provider: row?.provider ?? model.provider,
        capabilities: row ? parseCapabilities(row.capabilities) : declaredModelCapabilities(model),
        available: !!row,
        localCapable: model.pollinationsId === "__offline__" || model.kind === "image",
        remoteCapable: model.pollinationsId !== "__offline__",
        supportsStructuredOutput: row?.supportsStructuredOutput ?? false,
        availability: parseAvailability(row?.availability),
        overallElo: row?.elo ?? 1200,
        categoryElo: ratingsByModel.get(model.id) ?? {},
      };
    });
}

function parseAvailability(value: string | null | undefined): AvailableWorker["availability"] {
  return value === "available" || value === "unavailable" ? value : "unknown";
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function parsePersistedCapabilityMatch(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
