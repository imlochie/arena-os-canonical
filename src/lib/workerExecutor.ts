import { db } from "@/db";
import { cognitiveSessionAssignments, cognitiveSessions, workerExecutions } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { generate, type ChatMsg, type GenerateOpts } from "./ai";
import { generateStream } from "./stream";
import { requiresLocalExecution, storedExecutionMode } from "./executionPolicy";
import type { WorkforceAssignment } from "./workforceResolver";
import { getModel } from "./models";
import { ArenaRuntimeError } from "./errors";
import { appendSessionEvent } from "./sessionEvents";
import { decideExecutionRetry, normalizeFallbackPolicy, normalizeMaxAttempts, type FallbackPolicy } from "./retryPolicy";
import { selectFallbackWorkforceAssignment } from "./workforceRuntime";

export type WorkerOutputContract = "text" | "structured_json" | "image";
type ExecutorDatabase = typeof db;
type GenerateResult = Awaited<ReturnType<typeof generate>>;

export interface WorkerExecutorDependencies {
  database?: ExecutorDatabase;
  generate?: (options: GenerateOpts) => Promise<GenerateResult>;
  generateStream?: (options: GenerateOpts) => AsyncGenerator<string>;
}

export interface ExecuteWorkerRequest {
  sessionId?: string | null;
  assignment: Pick<WorkforceAssignment, "slot" | "requestedRole" | "provider" | "modelId"> & {
    executionMode: string;
  };
  messages: ChatMsg[];
  system?: string;
  temperature?: number;
  imageSize?: string;
  category?: string;
  keys?: GenerateOpts["keys"];
  outputContract?: WorkerOutputContract;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkerExecutionResult extends GenerateResult {
  executionId: string | null;
  actualProvider: string;
  actualModelId: string;
  attemptNumber: number;
}

export class WorkerExecutionError extends ArenaRuntimeError {
  constructor(input: {
    code: "WORKER_EXECUTION_FAILED" | "WORKER_TIMEOUT" | "INVALID_SESSION_STATE";
    message: string;
    sessionId: string | null;
    executionId?: string | null;
    retryable: boolean;
    cause?: unknown;
  }) {
    super({
      code: input.code,
      message: input.message,
      stage: input.code === "INVALID_SESSION_STATE" ? "session" : "execution",
      retryable: input.retryable,
      executionId: input.executionId ?? null,
      sessionId: input.sessionId,
    }, { cause: input.cause });
    this.name = "WorkerExecutionError";
  }

  get code() { return this.details.code; }
  get executionId() { return this.details.executionId; }
  get sessionId() { return this.details.sessionId; }
}

export async function executeWorker(
  request: ExecuteWorkerRequest,
  dependencies: WorkerExecutorDependencies = {}
): Promise<WorkerExecutionResult> {
  return executeWorkerChain(request, dependencies, true);
}

async function executeWorkerChain(
  request: ExecuteWorkerRequest,
  dependencies: WorkerExecutorDependencies,
  fallbackAllowed: boolean
): Promise<WorkerExecutionResult> {
  const context = await prepareExecution(request, dependencies.database ?? db);
  const generateImpl = dependencies.generate ?? generate;
  let previousExecutionId: string | null = null;
  let retryReason: string | null = null;

  for (;;) {
    const attempt = await startAttempt(context, previousExecutionId, retryReason);
    const route = predictedRoute(context.request.assignment.modelId, context.generateOptions.localOnly === true);
    try {
      const result = await generateImpl(context.generateOptions);
      const actualProvider = providerFromRoute(result.via);
      await completeAttempt(context, attempt, result.via, actualProvider);
      return {
        ...result,
        executionId: attempt.executionId,
        actualProvider,
        actualModelId: context.request.assignment.modelId,
        attemptNumber: attempt.attemptNumber,
      };
    } catch (error) {
      const failure = classifyFailure(error);
      const decision = decideExecutionRetry({
        attemptNumber: attempt.attemptNumber,
        maxAttempts: context.maxAttempts,
        retryable: failure.retryable,
      });
      await failAttempt(context, attempt, failure, route, decision.retry);
      if (decision.retry) {
        previousExecutionId = attempt.executionId;
        retryReason = failure.code;
        continue;
      }
      if (fallbackAllowed && failure.retryable && context.fallbackPolicy !== "none" && !context.persistedAssignment?.pinnedModelId) {
        let fallback: ExecuteWorkerRequest["assignment"];
        try {
          fallback = await createFallbackAssignment(context, attempt.executionId, failure.code);
        } catch (fallbackError) {
          await recordFallbackRejected(context, attempt.executionId, fallbackError);
          throw executionError(context.request, attempt.executionId, failure, fallbackError);
        }
        return executeWorkerChain({ ...request, assignment: fallback }, dependencies, false);
      }
      throw executionError(context.request, attempt.executionId, failure, error);
    }
  }
}

export async function executeWorkerStream(
  request: ExecuteWorkerRequest,
  dependencies: WorkerExecutorDependencies = {}
) {
  return executeWorkerStreamChain(request, dependencies, true);
}

async function executeWorkerStreamChain(
  request: ExecuteWorkerRequest,
  dependencies: WorkerExecutorDependencies,
  fallbackAllowed: boolean
): Promise<{ stream: AsyncGenerator<string>; executionId: string | null }> {
  const context = await prepareExecution(request, dependencies.database ?? db);
  const generateStreamImpl = dependencies.generateStream ?? generateStream;
  const firstAttempt = await startAttempt(context, null, null);
  const route = predictedStreamRoute(context.request.assignment.modelId, context.generateOptions.localOnly === true);

  const stream: AsyncGenerator<string> = (async function* (): AsyncGenerator<string> {
    let attempt = firstAttempt;
    for (;;) {
      let outputStarted = false;
      try {
        for await (const chunk of generateStreamImpl(context.generateOptions)) {
          outputStarted = true;
          yield chunk;
        }
        await completeAttempt(context, attempt, route, providerFromRoute(route));
        return;
      } catch (error) {
        const failure = classifyFailure(error);
        const decision = decideExecutionRetry({
          attemptNumber: attempt.attemptNumber,
          maxAttempts: context.maxAttempts,
          retryable: failure.retryable,
          outputStarted,
        });
        await failAttempt(context, attempt, failure, route, decision.retry);
        if (decision.retry) {
          attempt = await startAttempt(context, attempt.executionId, failure.code);
          continue;
        }
        if (fallbackAllowed && failure.retryable && !outputStarted && context.fallbackPolicy !== "none" && !context.persistedAssignment?.pinnedModelId) {
          let fallback: ExecuteWorkerRequest["assignment"];
          try {
            fallback = await createFallbackAssignment(context, attempt.executionId, failure.code);
          } catch (fallbackError) {
            await recordFallbackRejected(context, attempt.executionId, fallbackError);
            throw executionError(context.request, attempt.executionId, failure, fallbackError);
          }
          const next = await executeWorkerStreamChain({ ...request, assignment: fallback }, dependencies, false);
          for await (const chunk of next.stream) yield chunk;
          return;
        }
        throw executionError(context.request, attempt.executionId, failure, error);
      }
    }
  })();
  return { stream, executionId: firstAttempt.executionId };
}

interface ExecutionContext {
  request: ExecuteWorkerRequest;
  database: ExecutorDatabase;
  generateOptions: GenerateOpts;
  assignmentId: string | null;
  persistedAssignment: typeof cognitiveSessionAssignments.$inferSelect | null;
  maxAttempts: number;
  fallbackPolicy: FallbackPolicy;
}

async function prepareExecution(request: ExecuteWorkerRequest, database: ExecutorDatabase): Promise<ExecutionContext> {
  if (!request.sessionId) {
    const executionMode = storedExecutionMode(request.assignment.executionMode);
    if (!executionMode) throw invalidState(request, "Assigned worker has an invalid execution mode.");
    return {
      request, database, generateOptions: generateOptionsFor(request, executionMode),
      assignmentId: null, persistedAssignment: null, maxAttempts: 1, fallbackPolicy: "none",
    };
  }

  const [[assignment], [session]] = await Promise.all([
    database.select().from(cognitiveSessionAssignments).where(and(
      eq(cognitiveSessionAssignments.sessionId, request.sessionId),
      eq(cognitiveSessionAssignments.slot, request.assignment.slot),
      eq(cognitiveSessionAssignments.status, "active")
    )).orderBy(desc(cognitiveSessionAssignments.assignmentSequence)).limit(1),
    database.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, request.sessionId)).limit(1),
  ]);
  if (!session || !assignment || (assignment.assignmentSequence === 1 && assignment.modelId !== request.assignment.modelId)) {
    throw invalidState(request, "Persisted assignment does not match the requested worker execution.");
  }
  const executionMode = storedExecutionMode(assignment.executionMode);
  if (!executionMode) throw invalidState(request, "Persisted assignment has an invalid execution mode.");
  const effectiveRequest: ExecuteWorkerRequest = {
    ...request,
    assignment: {
      slot: assignment.slot,
      requestedRole: assignment.requestedRole,
      provider: assignment.provider,
      modelId: assignment.modelId,
      executionMode: assignment.executionMode,
    },
  };
  return {
    request: effectiveRequest,
    database,
    generateOptions: generateOptionsFor(effectiveRequest, executionMode),
    assignmentId: assignment.id,
    persistedAssignment: assignment,
    maxAttempts: normalizeMaxAttempts(session.maxExecutionAttempts),
    fallbackPolicy: normalizeFallbackPolicy(session.fallbackPolicy),
  };
}

function generateOptionsFor(request: ExecuteWorkerRequest, executionMode: "online" | "offline" | "local_only"): GenerateOpts {
  return {
    modelId: request.assignment.modelId,
    messages: request.messages,
    system: request.system,
    temperature: request.temperature,
    imageSize: request.imageSize,
    category: request.category,
    keys: requiresLocalExecution(executionMode) ? undefined : request.keys,
    localOnly: requiresLocalExecution(executionMode),
    strictRoute: true,
  };
}

async function recordFallbackRejected(
  context: ExecutionContext,
  failedExecutionId: string | null,
  error: unknown
) {
  if (!context.request.sessionId) return;
  await context.database.transaction((tx) => appendSessionEvent(tx, context.request.sessionId!, "fallback_rejected", {
    policy: context.fallbackPolicy,
    failedAssignmentId: context.assignmentId,
    failedExecutionId,
    reason: error instanceof Error ? error.message.slice(0, 500) : "fallback selection failed",
  }));
}

async function createFallbackAssignment(
  context: ExecutionContext,
  failedExecutionId: string | null,
  reason: string
) {
  const failed = context.persistedAssignment;
  const sessionId = context.request.sessionId;
  const executionMode = storedExecutionMode(failed?.executionMode);
  if (!failed || !sessionId || !executionMode || failed.pinnedModelId) {
    throw invalidState(context.request, failed?.pinnedModelId
      ? "Explicitly pinned worker exhausted retries; fallback is not permitted."
      : "Fallback requires a durable unpinned assignment.");
  }
  const policy = context.fallbackPolicy;
  if (policy === "none") throw invalidState(context.request, "Fallback policy is disabled.");
  const selected = await selectFallbackWorkforceAssignment({
    failedModelId: failed.modelId,
    failedProvider: failed.provider,
    policy,
    executionMode,
    request: {
      slot: failed.slot,
      requestedRole: failed.requestedRole,
      workforceRoleId: failed.workforceRoleId,
      requiredCapabilities: safelyParseStringArray(failed.capabilitiesConsidered),
    },
  }, context.database);

  return context.database.transaction(async (tx) => {
    const [superseded] = await tx.update(cognitiveSessionAssignments).set({ status: "superseded" })
      .where(and(eq(cognitiveSessionAssignments.id, failed.id), eq(cognitiveSessionAssignments.status, "active")))
      .returning();
    if (!superseded) throw invalidState(context.request, "Fallback assignment was already superseded.");
    const [replacement] = await tx.insert(cognitiveSessionAssignments).values({
      sessionId,
      slot: selected.slot,
      requestedRole: selected.requestedRole,
      workforceRoleId: selected.workforceRoleId,
      workerId: selected.workerId,
      provider: selected.provider,
      modelId: selected.modelId,
      executionMode: selected.executionMode,
      eligibilityDecision: selected.eligibilityDecision,
      workerAvailability: selected.workerAvailability,
      capabilitiesConsidered: JSON.stringify(selected.capabilitiesConsidered),
      assignmentSequence: failed.assignmentSequence + 1,
      supersedesAssignmentId: failed.id,
      reassignmentReason: reason,
      selectionReason: `controlled ${policy} fallback: ${selected.selectionReason}`,
      capabilityMatch: JSON.stringify(selected.capabilityMatch),
    }).returning();
    await appendSessionEvent(tx, sessionId, "fallback_triggered", {
      policy, failedAssignmentId: failed.id, failedExecutionId, reason,
    });
    await appendSessionEvent(tx, sessionId, "workforce_reassigned", {
      policy, failedAssignmentId: failed.id, assignmentId: replacement.id,
      slot: replacement.slot, workerId: replacement.workerId, modelId: replacement.modelId,
    });
    return {
      slot: replacement.slot,
      requestedRole: replacement.requestedRole,
      provider: replacement.provider,
      modelId: replacement.modelId,
      executionMode: replacement.executionMode,
    };
  });
}

async function startAttempt(
  context: ExecutionContext,
  previousExecutionId: string | null,
  retryReason: string | null
) {
  if (!context.assignmentId || !context.request.sessionId) {
    return { executionId: null, attemptNumber: previousExecutionId ? 2 : 1 };
  }
  const assignmentId = context.assignmentId;
  const sessionId = context.request.sessionId;
  return context.database.transaction(async (tx) => {
    const [reservation] = await tx.update(cognitiveSessionAssignments).set({
      nextExecutionAttempt: sql`${cognitiveSessionAssignments.nextExecutionAttempt} + 1`,
    }).where(eq(cognitiveSessionAssignments.id, assignmentId)).returning({
      attemptNumber: sql<number>`${cognitiveSessionAssignments.nextExecutionAttempt} - 1`,
    });
    if (!reservation) throw invalidState(context.request, "Worker assignment disappeared before execution.");
    const [execution] = await tx.insert(workerExecutions).values({
      sessionId,
      assignmentId,
      attemptNumber: reservation.attemptNumber,
      previousExecutionId,
      retryReason,
      fallbackPolicy: context.fallbackPolicy,
      fallbackSourceAssignmentId: context.persistedAssignment?.supersedesAssignmentId ?? null,
      selectedProvider: context.request.assignment.provider,
      selectedModelId: context.request.assignment.modelId,
      outputContract: context.request.outputContract ?? "text",
      metadata: JSON.stringify({
        slot: context.request.assignment.slot,
        requestedRole: context.request.assignment.requestedRole,
        ...(context.request.metadata ?? {}),
      }),
    }).returning();
    await appendSessionEvent(tx, sessionId, "worker_execution_started", {
      executionId: execution.id,
      assignmentId,
      attemptNumber: reservation.attemptNumber,
      previousExecutionId,
    });
    return { executionId: execution.id, attemptNumber: reservation.attemptNumber };
  });
}

async function completeAttempt(
  context: ExecutionContext,
  attempt: { executionId: string | null; attemptNumber: number },
  route: string,
  actualProvider: string
) {
  if (!attempt.executionId || !context.request.sessionId) return;
  await context.database.transaction(async (tx) => {
    await tx.update(workerExecutions).set({
      status: "completed",
      route,
      actualProvider,
      actualModelId: context.request.assignment.modelId,
      completedAt: new Date(),
    }).where(eq(workerExecutions.id, attempt.executionId!));
    await appendSessionEvent(tx, context.request.sessionId!, "worker_execution_completed", {
      executionId: attempt.executionId,
      assignmentId: context.assignmentId,
      attemptNumber: attempt.attemptNumber,
      route,
    });
  });
}

async function failAttempt(
  context: ExecutionContext,
  attempt: { executionId: string | null; attemptNumber: number },
  failure: { code: "WORKER_EXECUTION_FAILED" | "WORKER_TIMEOUT"; message: string; retryable: boolean },
  route: string,
  retryScheduled: boolean
) {
  if (!attempt.executionId || !context.request.sessionId) return;
  await context.database.transaction(async (tx) => {
    await tx.update(workerExecutions).set({
      status: "failed",
      route,
      actualProvider: providerFromRoute(route),
      actualModelId: context.request.assignment.modelId,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 1000),
      completedAt: new Date(),
    }).where(eq(workerExecutions.id, attempt.executionId!));
    await appendSessionEvent(tx, context.request.sessionId!, "worker_execution_failed", {
      executionId: attempt.executionId,
      assignmentId: context.assignmentId,
      attemptNumber: attempt.attemptNumber,
      errorCode: failure.code,
      retryable: failure.retryable,
    });
    if (retryScheduled) {
      await appendSessionEvent(tx, context.request.sessionId!, "worker_retry_scheduled", {
        executionId: attempt.executionId,
        assignmentId: context.assignmentId,
        attemptNumber: attempt.attemptNumber,
        nextAttemptNumber: attempt.attemptNumber + 1,
        fallbackPolicy: context.fallbackPolicy,
      });
    }
  });
}

function classifyFailure(error: unknown) {
  const timeout = error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
  return {
    code: timeout ? "WORKER_TIMEOUT" as const : "WORKER_EXECUTION_FAILED" as const,
    message: error instanceof Error ? error.message : "unknown worker execution failure",
    retryable: error instanceof ArenaRuntimeError ? error.details.retryable : true,
  };
}

function executionError(
  request: ExecuteWorkerRequest,
  executionId: string | null,
  failure: ReturnType<typeof classifyFailure>,
  cause: unknown
) {
  return new WorkerExecutionError({
    code: failure.code,
    message: failure.code === "WORKER_TIMEOUT"
      ? "Assigned worker timed out after retry attempts were exhausted."
      : `Assigned worker ${request.assignment.modelId} failed without fallback after retry attempts were exhausted.`,
    sessionId: request.sessionId ?? null,
    executionId,
    retryable: failure.retryable,
    cause,
  });
}

function invalidState(request: ExecuteWorkerRequest, message: string) {
  return new WorkerExecutionError({
    code: "INVALID_SESSION_STATE",
    message,
    sessionId: request.sessionId ?? null,
    retryable: false,
  });
}

function safelyParseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function providerFromRoute(route: string): string {
  if (route.startsWith("local:") || route === "offline") return "local_forge";
  if (route.startsWith("pollinations")) return "pollinations";
  return route.split(":")[0] || "unknown";
}

function predictedRoute(modelId: string, localOnly: boolean): string {
  const model = getModel(modelId);
  if (localOnly) return model.kind === "image" ? "local:image" : "local:text";
  if (modelId === "offline-sage") return "offline";
  if (model.kind === "image") return `pollinations-image:${model.pollinationsId.split(":")[1]}`;
  return `pollinations:${model.pollinationsId}`;
}

function predictedStreamRoute(modelId: string, localOnly: boolean): string {
  const model = getModel(modelId);
  if (localOnly) return model.kind === "image" ? "local:image" : "local:text";
  if (modelId === "offline-sage") return "offline";
  if (model.kind === "image") return `pollinations-image:${model.pollinationsId.split(":")[1]}`;
  return `pollinations-stream:${modelId}`;
}
