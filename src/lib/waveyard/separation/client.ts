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
