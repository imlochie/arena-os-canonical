/**
 * Connected-brain resolution — the pre-wired free-model default.
 *
 * Arena's model layer routes ANY text model through the best connected
 * provider (see lib/ai.ts): a Groq key → groq:free, else OpenRouter free
 * models, else TurboAgent local server, else keyless Pollinations, else the
 * honest offline Local Engine. This module answers one question for the UI:
 * "which brain will actually run right now, and how do I connect a better
 * one for free?"
 *
 * Pure `pickBrain` for tests; `readBrain`/`useBrain` for components.
 */

export type BrainProvider = "groq" | "openrouter" | "turboagent" | "local";

export interface Brain {
  provider: BrainProvider;
  /** Catalog model id that routes optimally through the provider. */
  modelId: string;
  label: string;
  detail: string;
  free: boolean;
}

export interface BrainKeys {
  groq?: string;
  openrouter?: string;
  turboagent?: string;
}

export const GROQ_SIGNUP_URL = "https://console.groq.com/keys";
export const OPENROUTER_SIGNUP_URL = "https://openrouter.ai/keys";

export function pickBrain(keys: BrainKeys): Brain {
  if (keys.groq?.trim()) {
    return {
      provider: "groq",
      modelId: "openai", // any text alias routes via groq:free when the key is sent
      label: "Groq free tier",
      detail: "Every agent, mission, and generation runs on your Groq key (groq:free) — fast Llama models, $0.",
      free: true,
    };
  }
  if (keys.openrouter?.trim()) {
    return {
      provider: "openrouter",
      modelId: "openai",
      label: "OpenRouter free models",
      detail: "Requests route through OpenRouter's free model pool on your key.",
      free: true,
    };
  }
  if (keys.turboagent?.trim()) {
    return {
      provider: "turboagent",
      modelId: "turboagent-7b",
      label: "TurboAgent local server",
      detail: "Runs against your own TurboAgent instance — nothing leaves your machine.",
      free: true,
    };
  }
  return {
    provider: "local",
    modelId: "local-engine",
    label: "Local Engine (offline)",
    detail:
      "Deterministic offline engine — instant, private, and honest, but it plans rather than reasons and cannot write arbitrary code.",
    free: true,
  };
}

/** localStorage shape is owned by KeysBar (af_key_groq / af_key_openrouter / af_url_turboagent). */
export function readBrainKeys(): BrainKeys {
  if (typeof window === "undefined") return {};
  try {
    return {
      groq: localStorage.getItem("af_key_groq") || undefined,
      openrouter: localStorage.getItem("af_key_openrouter") || undefined,
      turboagent: localStorage.getItem("af_url_turboagent") || undefined,
    };
  } catch {
    return {};
  }
}

export function readBrain(): Brain {
  return pickBrain(readBrainKeys());
}
