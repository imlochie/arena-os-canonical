/**
 * Separation model selection — the single place that decides which engine
 * id a new separation job targets. The UI never hardcodes engine ids: it
 * omits the model and the server resolves by what THIS machine can run.
 *
 * Desktop (local worker active): the app's own MDX registry model. Server
 * (Redis configured): the Python worker's Demucs model, as before.
 * SEPARATION_MODEL still overrides both for explicit deployments.
 */

import { isValidSeparationModelId, MDX_MODELS, SEPARATION_RECIPES } from "./mdx";
import { DEEP_MODE, deepModelSpec, DEEP_FOUR_MODEL_ID, deepStemsEnabled, isDeepSeparationMode } from "./modes";
import { localWorkerActive } from "../worker-local/broker";

export function defaultSeparationModel(): string {
  if (process.env.SEPARATION_MODEL) return process.env.SEPARATION_MODEL;
  if (localWorkerActive()) return MDX_MODELS[0].id;
  return "htdemucs";
}

/** What the UI offers for "separate into" — the fast 2-stem default, every
 *  registered recipe, and (when the mode is enabled) the deep six-source
 *  pass. Ids are accepted by the intake (server-validated). */
export function separationModelChoices(): Array<{
  id: string;
  label: string;
  description: string;
  stemCount: number;
  engine: "mdx" | "demucs";
}> {
  const choices: ReturnType<typeof separationModelChoices> = [
    {
      id: MDX_MODELS[0].id,
      label: "Vocals + instrumental",
      description: "one pass, the fastest way to stems",
      stemCount: 2,
      engine: "mdx",
    },
    ...SEPARATION_RECIPES.map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      stemCount: recipe.runs.length,
      engine: "mdx" as const,
    })),
  ];
  if (deepStemsEnabled()) { const spec = deepModelSpec(DEEP_FOUR_MODEL_ID); choices.push({ id: spec.id, label: spec.label, description: "Native four-source htdemucs checkpoint; not the MDX recipe", stemCount: spec.stems.length, engine: "demucs" }); choices.push(DEEP_MODE); }
  return choices;
}

/** Validate a client-requested model id: a registry model, a recipe, the
 *  deep pass (while its mode is enabled), or this machine's resolved
 *  default (server deployments run the Python worker's model, which the
 *  local registry does not know — still valid). */
export function isAcceptableSeparationModel(id: string): boolean {
  return isValidSeparationModelId(id) || isDeepSeparationMode(id) || id === defaultSeparationModel();
}
