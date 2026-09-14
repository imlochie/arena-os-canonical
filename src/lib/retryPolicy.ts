export const DEFAULT_MAX_EXECUTION_ATTEMPTS = 2;
export const MAX_EXECUTION_ATTEMPTS_LIMIT = 3;
export const FALLBACK_POLICIES = ["none", "same_provider", "eligible_worker"] as const;
export type FallbackPolicy = (typeof FALLBACK_POLICIES)[number];

export interface RetryDecisionInput {
  attemptNumber: number;
  maxAttempts: number;
  retryable: boolean;
  outputStarted?: boolean;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
}

export function decideExecutionRetry(input: RetryDecisionInput): RetryDecision {
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
  if (!input.retryable) return { retry: false, reason: "failure is not retryable" };
  if (input.outputStarted) return { retry: false, reason: "stream output already started" };
  if (input.attemptNumber >= maxAttempts) return { retry: false, reason: "maximum attempts exhausted" };
  return { retry: true, reason: "retryable failure below attempt limit" };
}

export function normalizeMaxAttempts(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_EXECUTION_ATTEMPTS;
  return Math.min(MAX_EXECUTION_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(value!)));
}

export function normalizeFallbackPolicy(value: string | null | undefined): FallbackPolicy {
  return value === "same_provider" || value === "eligible_worker" ? value : "none";
}
