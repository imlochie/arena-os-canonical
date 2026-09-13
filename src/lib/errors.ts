export type ErrorStage = "input" | "session" | "policy" | "selection" | "execution" | "output" | "persistence";

export type ArenaErrorCode =
  | "INVALID_REQUEST"
  | "SESSION_NOT_FOUND"
  | "INVALID_SESSION_STATE"
  | "NO_ELIGIBLE_WORKER"
  | "POLICY_VIOLATION"
  | "WORKER_EXECUTION_FAILED"
  | "WORKER_TIMEOUT"
  | "INVALID_OUTPUT"
  | "PERSISTENCE_FAILED"
  | "INTERNAL_ERROR"
  | string;

export interface ErrorDetails {
  code: ArenaErrorCode;
  message: string;
  stage: ErrorStage;
  retryable: boolean;
  executionId: string | null;
  sessionId: string | null;
}

export class ArenaRuntimeError extends Error {
  constructor(
    readonly details: ErrorDetails,
    options?: { cause?: unknown }
  ) {
    super(details.message, options);
    this.name = "ArenaRuntimeError";
  }
}

export function runtimeError(input: {
  code: ArenaErrorCode;
  message: string;
  stage: ErrorStage;
  retryable?: boolean;
  executionId?: string | null;
  sessionId?: string | null;
  cause?: unknown;
}) {
  return new ArenaRuntimeError({
    code: input.code,
    message: input.message,
    stage: input.stage,
    retryable: input.retryable ?? false,
    executionId: input.executionId ?? null,
    sessionId: input.sessionId ?? null,
  }, { cause: input.cause });
}
