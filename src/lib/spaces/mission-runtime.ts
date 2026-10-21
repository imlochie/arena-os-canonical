import type { GenerateResult, RuntimeExecution } from "@/lib/runtime";

export interface MissionRuntimeObservation {
  /** Model pinned by the mission plan for this agent turn. */
  agentModelId: string;
  /** Alias requested by generate(), when supplied. */
  requestedModelId: string;
  /** Actual provider and catalog model that produced the response. */
  runtimeLevel: GenerateResult["runtimeLevel"];
  provider: string;
  backend: GenerateResult["backend"];
  modelId: string;
  via: string;
  fallback: boolean;
  fallbackFrom?: RuntimeExecution;
  fallbackReason?: string;
}

/** Persist both the mission's intent and the generation layer's actual result. */
export function observeMissionRuntime(result: GenerateResult, agentModelId: string): MissionRuntimeObservation {
  return {
    agentModelId,
    requestedModelId: result.requestedModelId ?? agentModelId,
    runtimeLevel: result.runtimeLevel,
    provider: result.provider ?? result.backend,
    backend: result.backend,
    modelId: result.modelId,
    via: result.via,
    fallback: result.fallback,
    ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
}
