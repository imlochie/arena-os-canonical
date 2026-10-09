// Central AI runtime catalog.
//
// Every entry states its execution truth:
//   level   "arena-local" (deterministic offline engine — NOT an LLM)
//          "on-device"    (real on-device model inference)
//          "remote"       (real provider-backed inference over the network)
//   backend the execution path that actually runs when it is selected.
//
// A model can never claim a backend it does not use. See lib/runtime.ts.

export type RuntimeLevel = "arena-local" | "on-device" | "remote";
export type Backend =
  | "arena-local-engine"
  | "webllm"
  | "turboagent"
  | "pollinations"
  | "openrouter"
  | "groq";

export interface FreeModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  strengths: string[];
  /** Expectation label, not a measurement. */
  speed: "instant" | "fast" | "medium";
  /** Provider/expectation claim, not a measurement. */
  quality: number;
  level: RuntimeLevel;
  backend: Backend;
  requiresNetwork: boolean;
  requiresKey: boolean;
  requiresDownload: boolean;
  /** Execution routing id (pollinations model, __turboagent__:hf, __webllm__:mlc, …). */
  pollinationsId: string;
  emoji: string;
  color: string;
  kind: "text" | "image";
}

/** The built-in engine — one honest entry, not a lineup of fake models. */
export const LOCAL_ENGINE_ID = "local-engine";
export const LOCAL_CANVAS_ID = "local-canvas";

/** Legacy catalog ids → current ids, so old rows and defaults keep resolving. */
export const MODEL_ALIASES: Record<string, string> = {
  "offline-sage": LOCAL_ENGINE_ID,
};

export const STRUCTURED_OUTPUT_MODELS = new Set([
  "openai", "deepseek", "claude", "gemini", "qwen", "kimi", "offline-sage",
]);

export function declaredModelCapabilities(model: FreeModel): string[] {
  return [
    ...model.strengths.map((strength) => strength.toLowerCase().replaceAll(" ", "_")),
    ...(STRUCTURED_OUTPUT_MODELS.has(model.id) ? ["structured_output"] : []),
    ...(model.kind === "image" ? ["image_generation"] : ["text_generation"]),
    ...(model.pollinationsId === "__offline__" || model.kind === "image" ? ["local_execution"] : []),
    ...(model.pollinationsId !== "__offline__" ? ["remote_execution"] : []),
  ];
}

export const FREE_MODELS: FreeModel[] = [
  // ------------------------------------------------------------------
  // TIER 1 — LOCAL ENGINE (deterministic, offline, NOT an LLM)
  // ------------------------------------------------------------------
  {
    id: LOCAL_ENGINE_ID,
    name: "Local Engine",
    provider: "built-in · offline",
    description:
      "Deterministic offline engine — NOT an LLM. Structured responses, prompt term extraction, templating, local collaboration synthesis and judging heuristics. No model download, no API key, no network. Instant and private.",
    strengths: ["Offline", "Instant", "Private", "Deterministic"],
    speed: "instant",
    quality: 0,
    level: "arena-local",
    backend: "arena-local-engine",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__offline__",
    emoji: "⚙️",
    color: "#22c55e",
    kind: "text",
  },
  {
    id: LOCAL_CANVAS_ID,
    name: "Local Canvas",
    provider: "built-in · offline",
    description:
      "Deterministic offline procedural image canvas. No model, no network — seeded generative art, not model inference.",
    strengths: ["Offline", "Instant", "Private"],
    speed: "instant",
    quality: 0,
    level: "arena-local",
    backend: "arena-local-engine",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__image__:local",
    emoji: "🎨",
    color: "#22c55e",
    kind: "image",
  },

  // ------------------------------------------------------------------
  // TIER 3 — REMOTE FREE MODELS (real providers, network required)
  // ------------------------------------------------------------------
  {
    id: "openai",
    name: "GPT (Pollinations)",
    provider: "pollinations · openai",
    description:
      "OpenAI model served keyless through the Pollinations free route. Real remote inference — your request may leave this machine.",
    strengths: ["General", "Coding", "Reasoning"],
    speed: "fast",
    quality: 5,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "openai",
    emoji: "⚡",
    color: "#10a37f",
    kind: "text",
  },
  {
    id: "mistral",
    name: "Mistral (Pollinations)",
    provider: "pollinations · mistral",
    description:
      "Mistral model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Speed", "Summaries", "Multilingual"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "mistral",
    emoji: "🌬️",
    color: "#ff7000",
    kind: "text",
  },
  {
    id: "deepseek",
    name: "DeepSeek (Pollinations)",
    provider: "pollinations · deepseek",
    description:
      "DeepSeek model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Coding", "Math", "Reasoning"],
    speed: "medium",
    quality: 5,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "deepseek",
    emoji: "🧠",
    color: "#4d6bfe",
    kind: "text",
  },
  {
    id: "claude",
    name: "Claude (Pollinations)",
    provider: "pollinations · claude",
    description:
      "Claude model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Writing", "Analysis", "Safety"],
    speed: "medium",
    quality: 5,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "claude",
    emoji: "🟠",
    color: "#d97757",
    kind: "text",
  },
  {
    id: "gemini",
    name: "Gemini (Pollinations)",
    provider: "pollinations · gemini",
    description:
      "Gemini model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Long context", "Research", "Creative"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "gemini",
    emoji: "✨",
    color: "#1c7dff",
    kind: "text",
  },
  {
    id: "llama",
    name: "Llama (Pollinations)",
    provider: "pollinations · llama",
    description:
      "Llama model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Chat", "Open weights", "Versatile"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "llama",
    emoji: "🦙",
    color: "#7c3aed",
    kind: "text",
  },
  {
    id: "qwen",
    name: "Qwen (Pollinations)",
    provider: "pollinations · qwen",
    description:
      "Qwen model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Coding", "Tools", "Math"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "qwen",
    emoji: "🛠️",
    color: "#9333ea",
    kind: "text",
  },
  {
    id: "grok",
    name: "Grok (Pollinations)",
    provider: "pollinations · grok",
    description:
      "Grok model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Humor", "Current events", "Chat"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "grok",
    emoji: "😏",
    color: "#e5e5e5",
    kind: "text",
  },
  {
    id: "kimi",
    name: "Kimi (Pollinations)",
    provider: "pollinations · kimi",
    description:
      "Kimi reasoning model served keyless through the Pollinations free route. Real remote inference.",
    strengths: ["Reasoning", "Value", "Long context"],
    speed: "medium",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "kimi-k2-thinking",
    emoji: "🌙",
    color: "#06b6d4",
    kind: "text",
  },

  // ------------------------------------------------------------------
  // TIER 2 — LOCAL LLM (real on-device model inference)
  // ------------------------------------------------------------------
  {
    id: "webllm-qwen-coder-1.5b",
    name: "Qwen2.5 Coder 1.5B (WebLLM)",
    provider: "webllm · on-device",
    description:
      "Real Qwen2.5-Coder-1.5B inference in your browser via WebGPU. Model weights (~1 GB) download once, then run fully offline on your hardware. Server-side routes cannot execute this backend.",
    strengths: ["Real inference", "On device", "Code-tuned"],
    speed: "fast",
    quality: 3,
    level: "on-device",
    backend: "webllm",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: true,
    pollinationsId: "__webllm__:Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    emoji: "🌐",
    color: "#38bdf8",
    kind: "text",
  },
  {
    id: "webllm-llama-3.2-3b",
    name: "Llama 3.2 3B (WebLLM)",
    provider: "webllm · on-device",
    description:
      "Real Llama-3.2-3B inference in your browser via WebGPU. Model weights (~2 GB) download once, then run fully offline. Server-side routes cannot execute this backend.",
    strengths: ["Real inference", "On device", "Reasoning"],
    speed: "medium",
    quality: 4,
    level: "on-device",
    backend: "webllm",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: true,
    pollinationsId: "__webllm__:Llama-3.2-3B-Instruct-q4f16_1-MLC",
    emoji: "🦙",
    color: "#818cf8",
    kind: "text",
  },
  {
    id: "turboagent-32b",
    name: "Qwen2.5 32B (TurboAgent)",
    provider: "turboagent · local server",
    description:
      "Real Qwen2.5-32B inference on your own machine through a local TurboAgent server (NF4 + TurboQuant, 65k context on one 24GB GPU). Configure the server URL before use.",
    strengths: ["Real inference", "Long context", "Private"],
    speed: "medium",
    quality: 5,
    level: "on-device",
    backend: "turboagent",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__turboagent__:Qwen/Qwen2.5-32B-Instruct",
    emoji: "⚡",
    color: "#f59e0b",
    kind: "text",
  },
  {
    id: "turboagent-7b",
    name: "Qwen2.5 7B (TurboAgent)",
    provider: "turboagent · local server",
    description:
      "Real Qwen2.5-7B inference on your own machine through a local TurboAgent server. Light, fast, fully local on a single consumer GPU. Configure the server URL before use.",
    strengths: ["Real inference", "Fast", "Private"],
    speed: "fast",
    quality: 4,
    level: "on-device",
    backend: "turboagent",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__turboagent__:Qwen/Qwen2.5-7B-Instruct",
    emoji: "🔌",
    color: "#fbbf24",
    kind: "text",
  },

  // ------------------------------------------------------------------
  // Remote free image models
  // ------------------------------------------------------------------
  {
    id: "image-flux",
    name: "Flux (Pollinations)",
    provider: "pollinations · flux",
    description:
      "High-quality text-to-image through the Pollinations free image API. Real remote generation — the image is fetched from the network.",
    strengths: ["Detail", "Photos", "Art"],
    speed: "medium",
    quality: 5,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__image__:flux",
    emoji: "🎨",
    color: "#f59e0b",
    kind: "image",
  },
  {
    id: "image-turbo",
    name: "Turbo Image (Pollinations)",
    provider: "pollinations · turbo",
    description:
      "Fast text-to-image through the Pollinations free image API. Real remote generation.",
    strengths: ["Speed", "Anime", "Drafts"],
    speed: "fast",
    quality: 4,
    level: "remote",
    backend: "pollinations",
    requiresNetwork: true,
    requiresKey: false,
    requiresDownload: false,
    pollinationsId: "__image__:turbo",
    emoji: "🌪️",
    color: "#22d3ee",
    kind: "image",
  },
];

export function getModel(id: string): FreeModel {
  const resolved = MODEL_ALIASES[id] ?? id;
  return FREE_MODELS.find((m) => m.id === resolved) ?? FREE_MODELS[0];
}

export function textModels(): FreeModel[] {
  return FREE_MODELS.filter((m) => m.kind === "text");
}

export function imageModels(): FreeModel[] {
  return FREE_MODELS.filter((m) => m.kind === "image");
}

/** Battles compare genuinely different execution targets: never two
 *  Local Engine entries, and by default real models only. */
export function randomPair(): [FreeModel, FreeModel] {
  const pool = FREE_MODELS.filter(
    (m) => m.kind === "text" && m.level !== "arena-local" && !m.id.includes("webllm"),
  );
  const a = pool[Math.floor(Math.random() * pool.length)];
  let b = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (b.id === a.id && guard++ < 20) {
    b = pool[Math.floor(Math.random() * pool.length)];
  }
  return [a, b];
}

export function randomImagePair(): [FreeModel, FreeModel] {
  const pool = imageModels().filter((m) => m.level !== "arena-local");
  if (pool.length >= 2) {
    const a = pool[Math.floor(Math.random() * pool.length)];
    let b = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (b.id === a.id && guard++ < 20) {
      b = pool[Math.floor(Math.random() * pool.length)];
    }
    return [a, b];
  }
  return [pool[0], pool[0]];
}

export const CATEGORIES = [
  { id: "general", label: "General", emoji: "💬" },
  { id: "coding", label: "Coding", emoji: "💻" },
  { id: "writing", label: "Writing", emoji: "✍️" },
  { id: "reasoning", label: "Reasoning", emoji: "🧩" },
  { id: "roleplay", label: "Roleplay", emoji: "🎭" },
] as const;

export const LEADERBOARD_CATS = [
  { id: "overall", label: "Overall", emoji: "🌍" },
  ...CATEGORIES,
  { id: "image", label: "Image", emoji: "🖼️" },
] as const;
