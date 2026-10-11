/**
 * Processing runtime policy — ONE deliberate definition of who runs jobs,
 * shared by queue routing, server instrumentation, and the honest-status UI.
 *
 * Modes:
 *   external    REDIS_URL is set — BullMQ + the Waveyard worker container.
 *               Multi-instance/serverless deployments: web processes never
 *               run inference themselves.
 *   in-process  No Redis, and this process is a single-process runtime that
 *               owns processing: the desktop app (ARENA_DESKTOP_MODE=1), a
 *               local dev server (NODE_ENV=development), or an explicit
 *               opt-in (WAVEYARD_LOCAL_WORKER=1). The LocalJobBroker
 *               executes jobs inside this process.
 *   none        No Redis and no runtime that owns processing — enqueues
 *               fail honestly and the UI must say so (never an infinite
 *               "processing" spinner).
 *
 * Overrides (both directions): WAVEYARD_LOCAL_WORKER=1 forces in-process
 * even in a production build; WAVEYARD_LOCAL_WORKER=0 forces "none" even in
 * dev (e.g. running two dev servers where only one should process).
 * REDIS_URL always wins toward "external" — a deployment that configured a
 * worker must never get a surprise in-process one.
 */

export type ProcessingMode = "external" | "in-process" | "none";

export type RuntimePolicyEnv = {
  REDIS_URL?: string | undefined;
  ARENA_DESKTOP_MODE?: string | undefined;
  NODE_ENV?: string | undefined;
  WAVEYARD_LOCAL_WORKER?: string | undefined;
};

/** The deliberate policy (pure — env in, mode out). */
export function resolveProcessingMode(env: RuntimePolicyEnv = process.env): ProcessingMode {
  if (typeof env.REDIS_URL === "string" && env.REDIS_URL.length > 0) return "external";

  const override = typeof env.WAVEYARD_LOCAL_WORKER === "string" ? env.WAVEYARD_LOCAL_WORKER.trim() : "";
  if (override === "0") return "none";
  if (override === "1") return "in-process";

  if (env.ARENA_DESKTOP_MODE === "1") return "in-process";
  if (env.NODE_ENV === "development") return "in-process";
  return "none";
}

/** True when THIS process should execute jobs through the LocalJobBroker. */
export function shouldRunLocalWorker(env: RuntimePolicyEnv = process.env): boolean {
  return resolveProcessingMode(env) === "in-process";
}

/** The human explanation for the honest-status banner (pure). */
export function processingModeExplanation(mode: ProcessingMode): string {
  switch (mode) {
    case "external":
      return "Processing runs on the configured Waveyard worker (Redis queue).";
    case "in-process":
      return "Processing runs inside this application process — no setup needed.";
    case "none":
      return "No processor is configured for this deployment. Start the app locally (npm run dev or the desktop app) so this machine processes your audio, or configure REDIS_URL with the Waveyard worker.";
  }
}
