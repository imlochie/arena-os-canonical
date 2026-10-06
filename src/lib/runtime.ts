/**
 * Arena AI runtime abstraction — the multi-level execution contract.
 *
 * Three LEVELS, never to be confused with one another. A level describes HOW
 * an answer is produced — it is NOT an intelligence ranking:
 *
 *   LEVEL 0  "arena-local"  — the built-in deterministic offline engine.
 *                            NOT an LLM. Zero config, zero network, instant,
 *                            private, always available. The Arena baseline.
 *   LEVEL 1  "on-device"    — REAL model inference on the user's machine
 *                            (WebLLM in-browser via WebGPU, TurboAgent local
 *                            server). Weights and a runtime are required.
 *   LEVEL 2  "remote"       — REAL provider-backed inference over the network
 *                            (Pollinations keyless, OpenRouter/Groq BYOK).
 *                            Requests leave this machine.
 *
 * A model can never claim a backend it does not actually use: the catalog in
 * models.ts assigns each entry its level and backend, and generate()
 * (lib/ai.ts) returns what ACTUALLY executed, including fallback chains.
 */

import {
  getModel,
  LOCAL_ENGINE_ID,
  MODEL_ALIASES,
  type Backend,
  type FreeModel,
  type RuntimeLevel,
} from "./models";

export type { Backend, RuntimeLevel };

/** LEVEL 0/1/2 numbering for UI display. */
export const LEVEL_NUMBER: Record<RuntimeLevel, 0 | 1 | 2> = {
  "arena-local": 0,
  "on-device": 1,
  remote: 2,
};

export const LEVEL_LABELS: Record<RuntimeLevel, string> = {
  "arena-local": "Arena Local Engine",
  "on-device": "On-Device LLM",
  remote: "Remote Model",
};

export const LEVEL_DESCRIPTIONS: Record<RuntimeLevel, string> = {
  "arena-local":
    "Deterministic offline reasoning layer. Not an LLM — heuristic templates, term extraction, synthesis. No model download, no API key, no network. Instant, private, always available.",
  "on-device":
    "Real model inference on your device. Model weights required, uses your hardware, no cloud API required.",
  remote:
    "Real provider-backed models over the network. Your request may leave this machine. Free/keyless where marked; BYOK providers where configured.",
};

/** Which backends may appear in which level. A model outside its level's
 *  backend set is a catalog bug — tests assert this never happens. */
export const LEVEL_BACKENDS: Record<RuntimeLevel, readonly Backend[]> = {
  "arena-local": ["arena-local-engine"],
  "on-device": ["webllm", "turboagent"],
  remote: ["pollinations", "openrouter", "groq"],
};

/** The provider identity behind a backend (who actually serves the model). */
export const BACKEND_PROVIDER: Record<Backend, string> = {
  "arena-local-engine": "arena",
  webllm: "webllm",
  turboagent: "turboagent",
  pollinations: "pollinations",
  openrouter: "openrouter",
  groq: "groq",
};

export interface RuntimeModelInfo {
  id: string;
  displayName: string;
  level: RuntimeLevel;
  backend: Backend;
  kind: "text" | "image";
  capabilities: string[];
  /** Expectation, not a measurement. */
  speedExpectation: string;
  /** Expectation, not a measurement. */
  qualityExpectation: string;
  requiresNetwork: boolean;
  requiresKey: boolean;
  requiresDownload: boolean;
  /** Short honesty line shown under the name in selectors. */
  honesty: string;
}

export function resolveModelId(id: string): string {
  return MODEL_ALIASES[id] ?? id;
}

export function getRuntimeModel(id: string): FreeModel {
  return getModel(resolveModelId(id));
}

export function describeRuntimeModel(model: FreeModel): RuntimeModelInfo {
  const common = {
    id: model.id,
    displayName: model.name,
    level: model.level,
    backend: model.backend,
    kind: model.kind,
    capabilities: model.strengths,
    speedExpectation: `Expected ${model.speed} (unmeasured)`,
  };
  if (model.level === "arena-local") {
    return {
      ...common,
      speedExpectation: "Instant (deterministic)",
      qualityExpectation: "Not model intelligence — heuristic templates",
      requiresNetwork: false,
      requiresKey: false,
      requiresDownload: false,
      honesty:
        model.kind === "image"
          ? "Deterministic offline canvas · no network · no download"
          : "Deterministic offline engine · not an LLM · no network · no key",
    };
  }
  if (model.level === "on-device") {
    return {
      ...common,
      qualityExpectation: `Expected quality ${model.quality}/5 (catalog estimate, unmeasured)`,
      requiresNetwork: false,
      requiresKey: false,
      requiresDownload: model.backend === "webllm",
      honesty:
        model.backend === "webllm"
          ? "Real model in your browser · weights download required · uses your GPU"
          : "Real model on your machine · TurboAgent server required",
    };
  }
  return {
    ...common,
    qualityExpectation: `Expected quality ${model.quality}/5 (catalog estimate, unmeasured)`,
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    honesty: `☁ ${model.provider} — your request may leave this machine`,
  };
}

// ---------------------------------------------------------------------------
// Unified execution status (runtime-detected, never inferred from catalog)
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "ready" // level 0 always; configured + verified level 1/2
  | "loading" // model weights loading into memory
  | "download-required" // weights not present locally
  | "connecting" // probe in flight
  | "connected" // server/provider reachable (level 1/2 backends)
  | "api-key-required" // BYOK provider selected without a key
  | "network-unavailable" // egress to the provider failed
  | "webgpu-unavailable" // browser cannot run WebLLM
  | "server-unavailable" // TurboAgent (or other local server) unreachable
  | "provider-error" // provider responded with an error
  | "unavailable" // generic: cannot run right now
  | "error";

/** Is a status good enough to attempt generation? (Attempts are still honest:
 *  failures fall back visibly — this is UI affordance, not a guarantee.) */
export function statusAttemptable(status: ExecutionStatus): boolean {
  return status === "ready" || status === "connected";
}

// ---------------------------------------------------------------------------
// The generation contract — every generation returns what actually ran
// ---------------------------------------------------------------------------

/** What actually executed a generation. */
export interface RuntimeExecution {
  runtimeLevel: RuntimeLevel;
  backend: Backend;
  modelId: string;
}

export interface GenerateResult {
  text: string;
  runtimeLevel: RuntimeLevel;
  backend: Backend;
  /** The provider identity that served the execution.
   *  Optional at internal construction sites; the public generate() seam
   *  ALWAYS sets it (BACKEND_PROVIDER). */
  provider?: string;
  /** The catalog id that actually produced the text (local-engine on fallback). */
  modelId: string;
  /** What the user asked for (before alias resolution / fallback). */
  requestedModelId?: string;
  via: string;
  /** Measured total generation latency (ms). */
  ms: number;
  /** Alias of ms — the spec's canonical name. */
  latencyMs?: number;
  /** Measured time to first token (ms), where streaming is available. */
  firstTokenMs?: number;
  fallback: boolean;
  /** What the user asked for, when it differs from what ran. */
  fallbackFrom?: RuntimeExecution;
  /** Machine-ish reason for a fallback. */
  fallbackReason?: string;
  /** Human-readable note for a fallback or unavailable tier. */
  note?: string;
}

export const LOCAL_ENGINE_EXECUTION: RuntimeExecution = {
  runtimeLevel: "arena-local",
  backend: "arena-local-engine",
  modelId: LOCAL_ENGINE_ID,
};

export function localEngineResult(
  text: string,
  via: string,
  ms: number,
  extra?: {
    fallback?: boolean;
    fallbackFrom?: RuntimeExecution;
    note?: string;
    fallbackReason?: string;
    requestedModelId?: string;
  },
): GenerateResult {
  return {
    text,
    runtimeLevel: "arena-local",
    backend: "arena-local-engine",
    provider: "arena",
    modelId: LOCAL_ENGINE_ID,
    requestedModelId: extra?.requestedModelId,
    via,
    ms,
    latencyMs: ms,
    fallback: extra?.fallback ?? false,
    fallbackFrom: extra?.fallbackFrom,
    fallbackReason: extra?.fallbackReason,
    note: extra?.note,
  };
}

// ---------------------------------------------------------------------------
// Battle / comparison guard
// ---------------------------------------------------------------------------

export interface ComparisonVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * A model comparison is only meaningful between genuinely different
 * execution targets. Two selections that both resolve to the Arena Local
 * Engine are the same engine — comparing them proves nothing about models.
 */
export function comparisonVerdict(aModelId: string, bModelId: string): ComparisonVerdict {
  const a = getRuntimeModel(aModelId);
  const b = getRuntimeModel(bModelId);
  const sameEngine =
    a.backend === "arena-local-engine" && b.backend === "arena-local-engine";
  if (sameEngine) {
    return {
      allowed: false,
      reason:
        "These selections resolve to the same execution engine (Arena Local Engine). They cannot form a genuine model battle. Select an On-Device or Remote model for at least one side.",
    };
  }
  return { allowed: true };
}

/** Post-execution check: even with different selections, both may have
 *  fallen back to the Local Engine (e.g. offline). The battle must say so. */
export function executionsSameEngine(
  a: Pick<GenerateResult, "backend"> | null,
  b: Pick<GenerateResult, "backend"> | null,
): boolean {
  if (!a || !b) return false; // unknown execution → don't claim sameness
  return a.backend === "arena-local-engine" && b.backend === "arena-local-engine";
}

/**
 * ELO honesty: a battle is only rateable when BOTH sides genuinely executed
 * the model they claim. A fallback execution answering under a remote model's
 * name must never move that model's ELO, and the Arena Local Engine is the
 * baseline — it does not compete as a foundation model.
 */
export function battleRateable(
  a: Pick<GenerateResult, "backend" | "fallback"> | null,
  b: Pick<GenerateResult, "backend" | "fallback"> | null,
): boolean {
  if (!a || !b) return false;
  if (a.fallback || b.fallback) return false;
  if (a.backend === "arena-local-engine" || b.backend === "arena-local-engine") return false;
  return true;
}

// ---------------------------------------------------------------------------
// UI helpers (single source of truth for labels)
// ---------------------------------------------------------------------------

export function runtimeBadge(result: Pick<GenerateResult, "runtimeLevel" | "backend">): string {
  if (result.runtimeLevel === "arena-local") return "🔒 LEVEL 0 · Arena Local Engine · no network";
  if (result.runtimeLevel === "on-device") return "💻 LEVEL 1 · On-Device LLM";
  return "☁ LEVEL 2 · Remote Model · network required";
}

export function runtimeLine(result: GenerateResult): string {
  const base =
    result.runtimeLevel === "arena-local"
      ? "Arena Local Engine — deterministic offline engine"
      : result.runtimeLevel === "on-device"
        ? `On-Device LLM — ${result.modelId} via ${result.backend}`
        : `Remote Model — ${result.modelId} via ${result.backend}`;
  if (result.fallback && result.fallbackFrom) {
    const from = result.fallbackFrom;
    return `${base} (fallback: ${from.modelId} / ${from.backend} was unavailable — ${result.fallbackReason ?? result.note ?? "unavailable"})`;
  }
  return base;
}

/** Short "Powered by" line for room surfaces. */
export function poweredBy(result: Pick<GenerateResult, "runtimeLevel" | "backend" | "modelId" | "fallback">): string {
  if (result.fallback) return "Arena Local Engine (fallback)";
  if (result.runtimeLevel === "arena-local") return "Arena Local Engine";
  return `${result.modelId} · ${result.backend}`;
}
