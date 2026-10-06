/**
 * Arena AI runtime abstraction.
 *
 * Three tiers, never to be confused with one another:
 *
 *   local-engine  — the built-in deterministic offline engine. NOT an LLM.
 *                   Zero config, zero network, instant, private.
 *   local-llm     — REAL model inference on the user's machine
 *                   (WebLLM in-browser, TurboAgent local server). Weights
 *                   and a runtime are required.
 *   remote-free   — REAL provider-backed inference over the network
 *                   (Pollinations keyless, OpenRouter/Groq BYOK). Requests
 *                   may leave this machine.
 *
 * A model can never claim a backend it does not actually use: the catalog
 * in models.ts assigns each entry its tier and backend, and generate()
 * (lib/ai.ts) returns what ACTUALLY executed, including fallback chains.
 */

import {
  getModel,
  LOCAL_ENGINE_ID,
  MODEL_ALIASES,
  type Backend,
  type FreeModel,
  type RuntimeTier,
} from "./models";

export type { Backend, RuntimeTier };



export const TIER_LABELS: Record<RuntimeTier, string> = {
  "local-engine": "Local Engine",
  "local-llm": "Local LLM",
  "remote-free": "Remote Free Models",
};

export const TIER_DESCRIPTIONS: Record<RuntimeTier, string> = {
  "local-engine":
    "Deterministic offline engine. Not an LLM — structured heuristic responses, no model download, no API key, no network, instant, private.",
  "local-llm":
    "Real model inference on your device. Model weights required, uses your hardware, no cloud API required.",
  "remote-free":
    "Real provider-backed models over the network. Your request may leave this machine.",
};

/** Which backends may appear in which tier. A model outside its tier's
 *  backend set is a catalog bug — tests assert this never happens. */
export const TIER_BACKENDS: Record<RuntimeTier, readonly Backend[]> = {
  "local-engine": ["arena-local-engine"],
  "local-llm": ["webllm", "turboagent"],
  "remote-free": ["pollinations", "openrouter", "groq"],
};

export interface RuntimeModelInfo {
  id: string;
  displayName: string;
  tier: RuntimeTier;
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
    tier: model.tier,
    backend: model.backend,
    kind: model.kind,
    capabilities: model.strengths,
    speedExpectation: `Expected ${model.speed} (unmeasured)`,
  };
  if (model.tier === "local-engine") {
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
  if (model.tier === "local-llm") {
    return {
      ...common,
      qualityExpectation: `Expected quality ${model.quality}/5 (provider claim)`,
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
    qualityExpectation: `Expected quality ${model.quality}/5 (provider claim)`,
    requiresNetwork: true,
    requiresKey: model.backend === "openrouter" || model.backend === "groq",
    requiresDownload: false,
    honesty: `☁ ${model.provider} — your request may leave this machine`,
  };
}

/** What actually executed a generation. Returned by generate(). */
export interface RuntimeExecution {
  runtimeTier: RuntimeTier;
  backend: Backend;
  modelId: string;
}

export interface GenerateResult {
  text: string;
  runtimeTier: RuntimeTier;
  backend: Backend;
  /** The catalog id that actually produced the text (local-engine on fallback). */
  modelId: string;
  via: string;
  ms: number;
  fallback: boolean;
  /** What the user asked for, when it differs from what ran. */
  fallbackFrom?: RuntimeExecution;
  /** Human-readable reason for a fallback or unavailable tier. */
  note?: string;
}

export const LOCAL_ENGINE_EXECUTION: RuntimeExecution = {
  runtimeTier: "local-engine",
  backend: "arena-local-engine",
  modelId: LOCAL_ENGINE_ID,
};

export function localEngineResult(
  text: string,
  via: string,
  ms: number,
  extra?: { fallback?: boolean; fallbackFrom?: RuntimeExecution; note?: string },
): GenerateResult {
  return {
    text,
    runtimeTier: "local-engine",
    backend: "arena-local-engine",
    modelId: LOCAL_ENGINE_ID,
    via,
    ms,
    fallback: extra?.fallback ?? false,
    fallbackFrom: extra?.fallbackFrom,
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
 * execution targets. Two selections that both resolve to the Local Engine
 * are the same engine — comparing them proves nothing about models.
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
        "These are the same execution engine. Model comparison is unavailable in Local Engine mode — select a Local LLM or a Remote Free Model for at least one side.",
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

// ---------------------------------------------------------------------------
// UI helpers (single source of truth for labels)
// ---------------------------------------------------------------------------

export function runtimeBadge(result: Pick<GenerateResult, "runtimeTier" | "backend">): string {
  if (result.runtimeTier === "local-engine") return "🔒 Local Engine · no network";
  if (result.runtimeTier === "local-llm") return "💻 Local LLM · on device";
  return "☁ Remote · network required";
}

export function runtimeLine(result: GenerateResult): string {
  const base =
    result.runtimeTier === "local-engine"
      ? "Local Engine — deterministic offline engine"
      : result.runtimeTier === "local-llm"
        ? `Local LLM — ${result.modelId} via ${result.backend}`
        : `Remote Free Model — ${result.modelId} via ${result.backend}`;
  if (result.fallback && result.fallbackFrom) {
    const from = result.fallbackFrom;
    return `${base} (fallback: ${from.modelId} / ${from.backend} was unavailable)`;
  }
  return base;
}
