import type { AvailableWorker } from "./workforceResolver";

export const EXECUTION_MODES = ["online", "offline", "local_only"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface WorkerEligibility {
  worker: AvailableWorker;
  eligible: boolean;
  reason: string;
}

export class ExecutionPolicyError extends Error {
  constructor(
    message: string,
    readonly executionMode: ExecutionMode,
    readonly reason: string,
    readonly code: "NO_ELIGIBLE_WORKER" | "INVALID_EXECUTION_MODE" = "NO_ELIGIBLE_WORKER"
  ) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

export function resolveExecutionMode(body: unknown): ExecutionMode {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const requested = value.executionMode;
  if (requested !== undefined && !EXECUTION_MODES.includes(requested as ExecutionMode)) {
    throw new ExecutionPolicyError(
      `Unsupported execution mode: ${String(requested)}`,
      "online",
      "execution mode must be online, offline, or local_only",
      "INVALID_EXECUTION_MODE"
    );
  }
  if (process.env.FORCE_LOCAL_MODE === "1" || value.localOnly === true) return "local_only";
  return (requested as ExecutionMode | undefined) ?? "online";
}

export function executionPolicyFailure(error: unknown) {
  if (error instanceof ExecutionPolicyError) return {
    code: error.code,
    message: error.message,
    executionMode: error.executionMode,
    reason: error.reason,
  };
  if (error && typeof error === "object" && "code" in error && error.code === "NO_ELIGIBLE_WORKER") {
    const candidate = error as { message?: unknown; reason?: unknown };
    return {
      code: "NO_ELIGIBLE_WORKER" as const,
      message: typeof candidate.message === "string" ? candidate.message : "No eligible worker is available.",
      reason: typeof candidate.reason === "string" ? candidate.reason : "capability or availability requirements were not met",
    };
  }
  return null;
}

export function storedExecutionMode(
  executionMode: string | null | undefined,
  metadata?: string | null
): ExecutionMode | null {
  return EXECUTION_MODES.includes(executionMode as ExecutionMode)
    ? executionMode as ExecutionMode
    : persistedExecutionMode(metadata);
}

export function persistedExecutionMode(metadata: string | null | undefined): ExecutionMode | null {
  try {
    const value = JSON.parse(metadata ?? "{}").executionMode;
    return EXECUTION_MODES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function requiresLocalExecution(mode: ExecutionMode): boolean {
  return mode === "offline" || mode === "local_only";
}

export function enforceExecutionPolicy(
  workers: AvailableWorker[],
  executionMode: ExecutionMode,
  pinnedModelIds: string[] = []
) {
  const decisions = evaluateWorkerEligibility(workers, executionMode);
  for (const modelId of pinnedModelIds) {
    const pinned = decisions.find((decision) => decision.worker.modelId === modelId);
    if (pinned && !pinned.eligible) {
      throw new ExecutionPolicyError(
        `Pinned worker ${modelId} is not eligible under ${executionMode} policy.`,
        executionMode,
        pinned.reason
      );
    }
  }
  const eligibleWorkers = decisions.filter((decision) => decision.eligible).map((decision) => decision.worker);
  if (eligibleWorkers.length === 0) {
    throw new ExecutionPolicyError(
      `No worker is eligible under ${executionMode} policy.`,
      executionMode,
      decisions.map((decision) => `${decision.worker.modelId}: ${decision.reason}`).join("; ")
    );
  }
  return {
    eligibleWorkers,
    eligibilityReasons: new Map(decisions.map((decision) => [decision.worker.id, decision.reason])),
    decisions,
  };
}

/** Eligibility is policy-only. Ranking remains Workforce's responsibility. */
export function evaluateWorkerEligibility(
  workers: AvailableWorker[],
  executionMode: ExecutionMode
): WorkerEligibility[] {
  return workers.map((worker) => {
    if (requiresLocalExecution(executionMode) && !worker.localCapable) {
      return { worker, eligible: false, reason: `${executionMode} prohibits remote-only workers` };
    }
    if (executionMode === "online" && !worker.localCapable && !worker.remoteCapable) {
      return { worker, eligible: false, reason: "worker has no executable resource" };
    }
    return {
      worker,
      eligible: true,
      reason: executionMode === "online"
        ? "online permits this worker's execution resources"
        : `${executionMode} permits local-capable workers`,
    };
  });
}
