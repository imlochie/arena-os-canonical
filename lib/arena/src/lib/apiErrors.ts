import { ArenaRuntimeError, type ErrorDetails, type ErrorStage } from "./errors";

export interface ErrorFallback {
  code: string;
  message: string;
  stage: ErrorStage;
  retryable?: boolean;
  status?: number;
  sessionId?: string | null;
}

export function serializeApiError(error: unknown, fallback: ErrorFallback): ErrorDetails {
  if (error instanceof ArenaRuntimeError) return error.details;

  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "string" && isKnownEligibilityCode(value.code)) {
      return {
        code: value.code,
        message: typeof value.message === "string" ? value.message : fallback.message,
        stage: value.code === "POLICY_VIOLATION" || value.code === "INVALID_EXECUTION_MODE"
          ? "policy"
          : "selection",
        retryable: false,
        executionId: typeof value.executionId === "string" ? value.executionId : null,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : fallback.sessionId ?? null,
      };
    }
  }

  return {
    code: fallback.code,
    message: fallback.message,
    stage: fallback.stage,
    retryable: fallback.retryable ?? false,
    executionId: null,
    sessionId: fallback.sessionId ?? null,
  };
}

export function apiErrorResponse(error: unknown, fallback: ErrorFallback) {
  const details = serializeApiError(error, fallback);
  return Response.json({ ok: false, error: details }, {
    status: error instanceof ArenaRuntimeError
      ? statusForCode(details.code)
      : fallback.status ?? statusForCode(details.code),
  });
}

export function standardApiError(code: string, message: string, status: number) {
  const stage: ErrorStage = status >= 500 ? "persistence" : status === 404 || status === 409 ? "session" : "input";
  const details: ErrorDetails = {
    code,
    message,
    stage,
    retryable: status >= 500,
    executionId: null,
    sessionId: null,
  };
  return Response.json({ ok: false, error: details }, { status });
}

export function validationError(
  code: string,
  message: string,
  status = 400,
  stage: ErrorStage = "input"
) {
  const details: ErrorDetails = {
    code,
    message,
    stage,
    retryable: false,
    executionId: null,
    sessionId: null,
  };
  return Response.json({ ok: false, error: details }, { status });
}

function statusForCode(code: string): number {
  if (code === "SESSION_NOT_FOUND") return 404;
  if (code === "INVALID_SESSION_STATE") return 409;
  if (code === "NO_ELIGIBLE_WORKER" || code === "POLICY_VIOLATION" || code === "INVALID_EXECUTION_MODE" || code === "INVALID_OUTPUT") return 422;
  if (code === "WORKER_TIMEOUT") return 504;
  return 500;
}

function isKnownEligibilityCode(code: string) {
  return code === "NO_ELIGIBLE_WORKER" || code === "POLICY_VIOLATION" || code === "INVALID_EXECUTION_MODE";
}
