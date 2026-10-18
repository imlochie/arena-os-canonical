/**
 * Stem-engine status client — the browser-side half of first-run model
 * preparation. Plain fetch only: this module is imported by client
 * components and must never pull server code into the browser bundle.
 */

export type StemEngineModelStatus = {
  id: string;
  label: string;
  primaryStem: string;
  secondaryStem: string;
  sizeBytes: number | null;
  ready: boolean;
};

/** Real state of this machine's models, or null when the status cannot be
 *  read (unauthenticated / server unreachable) — callers treat that as
 *  "say nothing" rather than inventing a state. */
export async function fetchStemEngineStatus(): Promise<StemEngineModelStatus[] | null> {
  try {
    const response = await fetch("/api/waveyard/separation/models", { cache: "no-store" });
    if (!response.ok) return null;
    const json = (await response.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) return null;
    return json.models.filter(
      (model): model is StemEngineModelStatus =>
        typeof model?.id === "string" &&
        typeof model?.label === "string" &&
        typeof model?.ready === "boolean",
    );
  } catch {
    return null;
  }
}

export type StemEngineDeepStatus = {
  enabled: boolean;
  modelId: string;
  label: string;
  stems: string[];
  prepared: boolean;
  /** Why it is not prepared — the exact prepare step, or the runtime reason. */
  reason: string | null;
};

/** The deep pass's real state on this machine (the owner-prepared Demucs
 *  engine). Null when the status cannot be read — callers say nothing
 *  rather than inventing a state. */
export async function fetchDeepEngineStatus(): Promise<StemEngineDeepStatus | null> {
  try {
    const response = await fetch("/api/waveyard/separation/models", { cache: "no-store" });
    if (!response.ok) return null;
    const json = (await response.json()) as { deep?: Partial<StemEngineDeepStatus> | null };
    const deep = json.deep;
    if (deep === null || deep === undefined || typeof deep.prepared !== "boolean" || typeof deep.modelId !== "string") {
      return null;
    }
    return {
      enabled: deep.enabled !== false,
      modelId: deep.modelId,
      label: typeof deep.label === "string" ? deep.label : "Deep — 6 stems",
      stems: Array.isArray(deep.stems) ? deep.stems.filter((stem): stem is string => typeof stem === "string") : [],
      prepared: deep.prepared,
      reason: typeof deep.reason === "string" ? deep.reason : null,
    };
  } catch {
    return null;
  }
}

/** One-time model download. Resolves with the number of failed separations
 *  the server re-enqueued after installing (the seed sweep). */
export async function prepareStemEngine(
  modelId: string,
): Promise<{ ok: true; requeued: number } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/waveyard/separation/models/${encodeURIComponent(modelId)}/seed`, {
      method: "POST",
    });
    const json = (await response.json().catch(() => ({}))) as { error?: unknown; requeued?: unknown };
    if (!response.ok) {
      return { ok: false, error: typeof json.error === "string" ? json.error : "The stem engine model could not be prepared." };
    }
    return { ok: true, requeued: typeof json.requeued === "number" ? json.requeued : 0 };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The stem engine model could not be prepared." };
  }
}

// ------------------------------------------------------- deep preparation

export type DeepPreparationStatus = {
  state: string;
  step: string | null;
  progress: { percent: number; label: string } | null;
  steps: Array<{ id: string; label: string; state: string }>;
  consent: { required: string[]; granted: string[]; grantedAt: string | null };
  error: { code: string; message: string } | null;
  log: string[];
  environment: {
    python: string | null;
    pythonVersion: string | null;
    demucsVersion: string | null;
    torchVersion: string | null;
    checkpointPath: string;
    checkpointPresent: boolean;
    checkpointVerified: boolean | null;
    managedEnvDir: string;
    modelsDir: string;
  };
  result: { provenance: string | null; readyAt: string | null };
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
};

export type DeepPreparationConsent = {
  id: string;
  kind: "runtime" | "install" | "download";
  label: string;
  reason: string;
  sizeBytes: number | null;
  source: string;
  destination: string;
  license: string;
};

export type DeepPreparationStep = { id: string; label: string; detail: string };
export type DeepPreparationPhase = { state: string; steps: DeepPreparationStep[] };
export type DeepPreparationPlan = {
  phases: DeepPreparationPhase[];
  needsConsent: boolean;
  consent: DeepPreparationConsent[];
};

export type DeepPreparationInspect = {
  status: DeepPreparationStatus;
  runtime: { processingMode: string; engine: { prepared: boolean; reason: string | null } };
  report?: unknown;
  plan?: DeepPreparationPlan;
};

/** The durable preparation status (cheap, pollable). */
export async function fetchDeepPreparation(inspect = false): Promise<DeepPreparationInspect | null> {
  try {
    const response = await fetch(`/api/waveyard/separation/deep/prepare${inspect ? "?inspect=1" : ""}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as DeepPreparationInspect;
  } catch {
    return null;
  }
}

/** Start (or resume) preparation with the granted consents. */
export async function startDeepPreparation(
  consent: readonly string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/waveyard/separation/deep/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent }),
    });
    const json = (await response.json().catch(() => ({}))) as { outcome?: string; missing?: unknown; state?: unknown };
    if (response.ok) return { ok: true };
    if (json.outcome === "consent-missing" && Array.isArray(json.missing)) {
      return { ok: false, error: `Agree to the required steps first: ${(json.missing as string[]).join(", ")}.` };
    }
    if (json.outcome === "already-running") {
      return { ok: false, error: "Preparation is already running — its progress is shown below." };
    }
    return { ok: false, error: "Preparation could not be started." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Preparation could not be started." };
  }
}

export async function cancelDeepPreparation(): Promise<{ ok: boolean }> {
  try {
    const response = await fetch("/api/waveyard/separation/deep/prepare/cancel", { method: "POST" });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

export async function recoverDeepPreparation(): Promise<{ ok: boolean }> {
  try {
    const response = await fetch("/api/waveyard/separation/deep/prepare/recover", { method: "POST" });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

/** Import a checkpoint the owner already possesses. */
export async function importDeepCheckpoint(
  file: File,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const form = new FormData();
    form.set("checkpoint", file);
    const response = await fetch("/api/waveyard/separation/deep/prepare/import", { method: "POST", body: form });
    const json = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (response.ok) return { ok: true };
    return { ok: false, error: typeof json.error === "string" ? json.error : "The checkpoint could not be imported." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The checkpoint could not be imported." };
  }
}
