import type { AvailableWorker, WorkforceRequest } from "./workforceResolver";

export interface WorkerSuitabilityDecision {
  slot: string;
  worker: AvailableWorker;
  eligible: boolean;
  reason: string;
}

export class WorkerSuitabilityError extends Error {
  readonly code = "NO_ELIGIBLE_WORKER";
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "WorkerSuitabilityError";
  }
}

/** Filters declared capability and current registry availability per requested slot. */
export function enforceWorkerSuitability(workers: AvailableWorker[], requests: WorkforceRequest[]) {
  const decisions: WorkerSuitabilityDecision[] = [];
  const eligibleWorkersBySlot = new Map<string, AvailableWorker[]>();
  const suitabilityReasons = new Map<string, string>();

  for (const request of requests) {
    const slotDecisions = workers.map((worker): WorkerSuitabilityDecision => {
      let reason: string;
      let eligible = true;
      if (!worker.available) {
        eligible = false;
        reason = "worker is not registered";
      } else {
        const missing = (request.requiredCapabilities ?? [])
          .filter((capability) => !supportsCapability(worker, capability));
        if (missing.length) {
          eligible = false;
          reason = `missing required capabilities: ${missing.join(", ")}`;
        } else if (worker.availability === "unavailable") {
          eligible = false;
          reason = "worker availability is unavailable";
        } else {
          reason = worker.availability === "available"
            ? "capable; availability confirmed available"
            : "capable; availability unknown (permitted without active polling)";
        }
      }
      suitabilityReasons.set(`${request.slot}:${worker.id}`, reason);
      return { slot: request.slot, worker, eligible, reason };
    });
    decisions.push(...slotDecisions);

    if (request.pinnedModelId) {
      const pinned = slotDecisions.find((item) => item.worker.modelId === request.pinnedModelId);
      if (pinned && !pinned.eligible) {
        throw new WorkerSuitabilityError(
          `Pinned worker ${request.pinnedModelId} is not currently suitable for ${request.slot}.`,
          pinned.reason
        );
      }
    }
    const eligible = slotDecisions.filter((decision) => decision.eligible).map((decision) => decision.worker);
    if (!eligible.length) {
      throw new WorkerSuitabilityError(
        `No capable and available worker satisfies ${request.slot}.`,
        slotDecisions.map((decision) => `${decision.worker.modelId}: ${decision.reason}`).join("; ")
      );
    }
    eligibleWorkersBySlot.set(request.slot, eligible);
  }
  return { eligibleWorkersBySlot, suitabilityReasons, decisions };
}

function supportsCapability(worker: AvailableWorker, capability: string): boolean {
  if (capability === "structured_output") return worker.supportsStructuredOutput;
  return worker.capabilities.includes(capability);
}
