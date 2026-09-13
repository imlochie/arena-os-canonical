import { getRole, type WorkforceRole } from "./workforce";

export type WorkforceSlot = string;

export interface AvailableWorker {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  capabilities: string[];
  available: boolean;
  localCapable: boolean;
  remoteCapable: boolean;
  supportsStructuredOutput: boolean;
  availability: "available" | "unavailable" | "unknown";
  overallElo: number;
  categoryElo: Record<string, number>;
}

export interface WorkforceRequest {
  slot: WorkforceSlot;
  requestedRole: string;
  workforceRoleId: string;
  pinnedModelId?: string;
  requiredCapabilities?: string[];
}

export interface WorkforceAssignment {
  slot: WorkforceSlot;
  requestedRole: string;
  workforceRoleId: string;
  workerId: string;
  workerName: string;
  provider: string;
  modelId: string;
  executionMode: "online" | "offline" | "local_only";
  eligibilityDecision: string;
  workerAvailability: "available" | "unavailable" | "unknown";
  capabilitiesConsidered: string[];
  selectionReason: string;
  capabilityMatch: string[];
  promptFragment: string;
}

export function resolveWorkforceAssignments(
  requests: WorkforceRequest[],
  workers: AvailableWorker[],
  policy: {
    executionMode?: "online" | "offline" | "local_only";
    eligibilityReasons?: ReadonlyMap<string, string>;
    eligibleWorkersBySlot?: ReadonlyMap<string, AvailableWorker[]>;
    suitabilityReasons?: ReadonlyMap<string, string>;
    distinctWorkers?: boolean;
  } = {}
): WorkforceAssignment[] {
  const available = workers.filter((worker) => worker.available);
  if (available.length === 0) throw new Error("no Workforce workers available");
  const used = new Set<string>();
  return requests.map((request) => {
    const eligible = policy.eligibleWorkersBySlot?.get(request.slot) ?? available;
    const distinct = policy.distinctWorkers
      ? eligible.filter((worker) => !used.has(worker.id))
      : eligible;
    const candidates = distinct.length ? distinct : eligible;
    const assignment = resolveAssignment(request, candidates, policy);
    used.add(assignment.workerId);
    return assignment;
  });
}

function resolveAssignment(
  request: WorkforceRequest,
  workers: AvailableWorker[],
  policy: {
    executionMode?: "online" | "offline" | "local_only";
    eligibilityReasons?: ReadonlyMap<string, string>;
    eligibleWorkersBySlot?: ReadonlyMap<string, AvailableWorker[]>;
    suitabilityReasons?: ReadonlyMap<string, string>;
  }
): WorkforceAssignment {
  const role = getRole(request.workforceRoleId);
  const pinned = request.pinnedModelId
    ? workers.find((worker) => worker.modelId === request.pinnedModelId)
    : undefined;
  if (request.pinnedModelId && !pinned) {
    throw new Error(`pinned Workforce model unavailable: ${request.pinnedModelId}`);
  }

  const preferred = workers.filter((worker) => role.preferredModels.includes(worker.modelId));
  const candidates = preferred.length ? preferred : workers;
  const ranked = [...candidates].sort((a, b) => compareWorkers(a, b, role));
  const worker = pinned ?? ranked[0];
  const categoryScore = worker.categoryElo[role.eloCategory];
  const preferredRank = role.preferredModels.indexOf(worker.modelId);
  const selectionReason = pinned
    ? `explicit session constraint for ${request.requestedRole}`
    : preferred.length
      ? `${role.name} capability match; highest ${role.eloCategory} rating among preferred available workers`
      : `${role.name} fallback; highest-rated available worker`;

  return {
    slot: request.slot,
    requestedRole: request.requestedRole,
    workforceRoleId: role.id,
    workerId: worker.id,
    workerName: worker.name,
    provider: worker.provider,
    modelId: worker.modelId,
    executionMode: policy.executionMode ?? "online",
    eligibilityDecision: [
      policy.eligibilityReasons?.get(worker.id) ?? "eligible under default online policy",
      policy.suitabilityReasons?.get(`${request.slot}:${worker.id}`),
    ].filter(Boolean).join("; "),
    workerAvailability: worker.availability,
    capabilitiesConsidered: request.requiredCapabilities ?? [],
    selectionReason,
    capabilityMatch: [
      `role:${role.id}`,
      `category:${role.eloCategory}`,
      ...(preferredRank >= 0 ? [`preferred-rank:${preferredRank + 1}`] : []),
      ...(categoryScore !== undefined ? [`category-elo:${categoryScore}`] : [`overall-elo:${worker.overallElo}`]),
      ...worker.capabilities.map((capability) => `capability:${capability.toLowerCase()}`),
    ],
    promptFragment: role.promptFragment,
  };
}

function compareWorkers(a: AvailableWorker, b: AvailableWorker, role: WorkforceRole): number {
  const categoryDifference = (b.categoryElo[role.eloCategory] ?? b.overallElo) -
    (a.categoryElo[role.eloCategory] ?? a.overallElo);
  if (categoryDifference !== 0) return categoryDifference;
  const preferenceDifference = preferenceRank(a.modelId, role) - preferenceRank(b.modelId, role);
  if (preferenceDifference !== 0) return preferenceDifference;
  const overallDifference = b.overallElo - a.overallElo;
  return overallDifference !== 0 ? overallDifference : a.modelId.localeCompare(b.modelId);
}

function preferenceRank(modelId: string, role: WorkforceRole): number {
  const index = role.preferredModels.indexOf(modelId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
