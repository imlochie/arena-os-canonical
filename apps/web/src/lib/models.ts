// Central catalog of FREE models usable in this personal arena.
// Text models route through the Pollinations free tier by default (no key),
// image models through the Pollinations image API (URL-based, no key),
// with automatic fallback to an offline generator so the app always works.

export interface FreeModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  strengths: string[];
  speed: "blazing" | "fast" | "medium";
  quality: number; // 1-5
  pollinationsId: string;
  emoji: string;
  color: string;
  kind: "text" | "image";
}

export const FREE_MODELS: FreeModel[] = [
  {
    id: "openai",
    name: "Forge GPT",
    provider: "pollinations · openai",
    description: "Best all-rounder. Great for chat, reasoning and coding.",
    strengths: ["General", "Coding", "Reasoning"],
    speed: "fast",
    quality: 5,
    pollinationsId: "openai",
    emoji: "⚡",
    color: "#10a37f",
    kind: "text",
  },
  {
    id: "mistral",
    name: "Mistral Forge",
    provider: "pollinations · mistral",
    description: "European open-weight speedster. Crisp, concise answers.",
    strengths: ["Speed", "Summaries", "Multilingual"],
    speed: "blazing",
    quality: 4,
    pollinationsId: "mistral",
    emoji: "🌬️",
    color: "#ff7000",
    kind: "text",
  },
  {
    id: "deepseek",
    name: "DeepSeek Forge",
    provider: "pollinations · deepseek",
    description: "Reasoning & code specialist. Loves step-by-step logic.",
    strengths: ["Coding", "Math", "Reasoning"],
    speed: "medium",
    quality: 5,
    pollinationsId: "deepseek",
    emoji: "🧠",
    color: "#4d6bfe",
    kind: "text",
  },
  {
    id: "claude",
    name: "Claude Forge",
    provider: "pollinations · claude",
    description: "Nuanced writing and careful instruction following.",
    strengths: ["Writing", "Analysis", "Safety"],
    speed: "medium",
    quality: 5,
    pollinationsId: "claude",
    emoji: "🟠",
    color: "#d97757",
    kind: "text",
  },
  {
    id: "gemini",
    name: "Gemini Forge",
    provider: "pollinations · gemini",
    description: "Huge context, multimodal brain. Great for long docs.",
    strengths: ["Long context", "Research", "Creative"],
    speed: "fast",
    quality: 4,
    pollinationsId: "gemini",
    emoji: "✨",
    color: "#1c7dff",
    kind: "text",
  },
  {
    id: "llama",
    name: "Llama Forge",
    provider: "pollinations · llama",
    description: "Meta's open-weight workhorse. Friendly and versatile.",
    strengths: ["Chat", "Open weights", "Versatile"],
    speed: "fast",
    quality: 4,
    pollinationsId: "llama",
    emoji: "🦙",
    color: "#7c3aed",
    kind: "text",
  },
  {
    id: "qwen",
    name: "Qwen Forge",
    provider: "pollinations · qwen",
    description: "Coder-flavoured open model. Strong at tools & code.",
    strengths: ["Coding", "Tools", "Math"],
    speed: "fast",
    quality: 4,
    pollinationsId: "qwen",
    emoji: "🛠️",
    color: "#9333ea",
    kind: "text",
  },
  {
    id: "grok",
    name: "Grok Forge",
    provider: "pollinations · grok",
    description: "Witty with real-time vibes. Fun, bold personality.",
    strengths: ["Humor", "Current events", "Chat"],
    speed: "fast",
    quality: 4,
    pollinationsId: "grok",
    emoji: "😏",
    color: "#e5e5e5",
    kind: "text",
  },
  {
    id: "kimi",
    name: "Kimi Thinker",
    provider: "pollinations · kimi",
    description: "Open reasoning model. Shows its work beautifully.",
    strengths: ["Reasoning", "Value", "Long context"],
    speed: "medium",
    quality: 4,
    pollinationsId: "kimi-k2-thinking",
    emoji: "🌙",
    color: "#06b6d4",
    kind: "text",
  },
  {
    id: "offline-sage",
    name: "Offline Sage",
    provider: "local · built-in",
    description: "Always-on fallback. Works with zero internet to AI APIs.",
    strengths: ["Offline", "Private", "Instant"],
    speed: "blazing",
    quality: 3,
    pollinationsId: "__offline__",
    emoji: "🛡️",
    color: "#22c55e",
    kind: "text",
  },
  {
    id: "image-flux",
    name: "Flux Canvas",
    provider: "pollinations · flux",
    description: "High-quality text-to-image. Rich detail, great photos & art.",
    strengths: ["Detail", "Photos", "Art"],
    speed: "medium",
    quality: 5,
    pollinationsId: "__image__:flux",
    emoji: "🎨",
    color: "#f59e0b",
    kind: "image",
  },
  {
    id: "image-turbo",
    name: "Turbo Canvas",
    provider: "pollinations · turbo",
    description: "Fast text-to-image. Great for drafts, anime & iteration.",
    strengths: ["Speed", "Anime", "Drafts"],
    speed: "blazing",
    quality: 4,
    pollinationsId: "__image__:turbo",
    emoji: "🌪️",
    color: "#22d3ee",
    kind: "image",
  },
];

export function getModel(id: string): FreeModel {
  return FREE_MODELS.find((m) => m.id === id) ?? FREE_MODELS[0];
}

export function textModels(): FreeModel[] {
  return FREE_MODELS.filter((m) => m.kind === "text");
}

export function imageModels(): FreeModel[] {
  return FREE_MODELS.filter((m) => m.kind === "image");
}

export function randomPair(): [FreeModel, FreeModel] {
  const pool = FREE_MODELS.filter((m) => m.kind === "text" && m.id !== "offline-sage");
  const a = pool[Math.floor(Math.random() * pool.length)];
  let b = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (b.id === a.id && guard++ < 20) {
    b = pool[Math.floor(Math.random() * pool.length)];
  }
  return [a, b];
}

export function randomImagePair(): [FreeModel, FreeModel] {
  const pool = imageModels();
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
