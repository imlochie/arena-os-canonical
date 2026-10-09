/**
 * Separation model selection — the single place that decides which engine
 * id a new separation job targets. The UI never hardcodes engine ids: it
 * omits the model and the server resolves by what THIS machine can run.
 *
 * Desktop (local worker active): the app's own MDX registry model. Server
 * (Redis configured): the Python worker's Demucs model, as before.
 * SEPARATION_MODEL still overrides both for explicit deployments.
 */

import { MDX_MODELS } from "./mdx";
import { localWorkerActive } from "../worker-local/broker";

export function defaultSeparationModel(): string {
  if (process.env.SEPARATION_MODEL) return process.env.SEPARATION_MODEL;
  if (localWorkerActive()) return MDX_MODELS[0].id;
  return "htdemucs";
}
