import { resolveExecutionMode, type ExecutionMode } from "./executionPolicy";
import { FALLBACK_POLICIES, normalizeMaxAttempts, type FallbackPolicy } from "./retryPolicy";
import { runtimeError } from "./errors";

export interface ExecutionConfig {
  mode: ExecutionMode;
  maxExecutionAttempts: number;
  fallbackPolicy: FallbackPolicy;
  localOnly: boolean;
}

export function parseExecutionConfig(input: unknown): ExecutionConfig {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const mode = resolveExecutionMode(body);
  const fallback = body.fallbackPolicy ?? "none";
  if (!FALLBACK_POLICIES.includes(fallback as FallbackPolicy)) throw runtimeError({
    code: "INVALID_FALLBACK_POLICY", message: "Fallback policy must be none, same_provider, or eligible_worker.",
    stage: "input", retryable: false,
  });
  return {
    mode,
    maxExecutionAttempts: normalizeMaxAttempts(typeof body.maxExecutionAttempts === "number" ? body.maxExecutionAttempts : undefined),
    fallbackPolicy: fallback as FallbackPolicy,
    localOnly: mode !== "online",
  };
}
