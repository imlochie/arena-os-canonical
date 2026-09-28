// On-device AI client (WebLLM / WebGPU). Lazy-loaded: the heavy runtime
// is only fetched when the user actually runs on-device AI. After the
// first model download, everything is cached and works fully offline.
// Client-only: never imported on the server (dynamic import inside funcs).

"use client";

export interface WebLLMModel {
  id: string;
  name: string;
  size: string;
  desc: string;
}

export const WEBLLM_MODELS: WebLLMModel[] = [
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen Coder 1.5B ⚡",
    size: "~1 GB",
    desc: "Fast + code-tuned. Best default for game generation.",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 3B 🧠",
    size: "~2 GB",
    desc: "Stronger reasoning, slower. Better for weird requests.",
  },
  {
    id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
    name: "SmolLM2 1.7B 🪶",
    size: "~1 GB",
    desc: "Lightest fallback for weak GPUs.",
  },
];

const LS_KEY = "af_arcade_model";

let engine: any = null;
let engineModelId: string | null = null;
let loading: Promise<any> | null = null;

export function getPreferredModel(): string {
  try {
    return localStorage.getItem(LS_KEY) || WEBLLM_MODELS[0].id;
  } catch {
    return WEBLLM_MODELS[0].id;
  }
}

export function setPreferredModel(id: string) {
  try {
    localStorage.setItem(LS_KEY, id);
  } catch {}
}

export function isEngineLoaded(): boolean {
  return !!engine;
}

export function loadedModelId(): string | null {
  return engineModelId;
}

export async function checkWebGPU(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const nav = navigator as any;
    if (!nav.gpu) return { ok: false, reason: "WebGPU not available in this browser. Use Chrome/Edge 113+ or Safari 26+." };
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "No WebGPU adapter found (driver blocked or headless)." };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "WebGPU check failed" };
  }
}

export interface LoadProgress {
  progress: number; // 0..1
  text: string;
}

export async function loadEngine(modelId: string, onProgress?: (p: LoadProgress) => void): Promise<any> {
  if (engine && engineModelId === modelId) return engine;
  if (loading && engineModelId === modelId) return loading;

  const gpu = await checkWebGPU();
  if (!gpu.ok) throw new Error(gpu.reason ?? "WebGPU unavailable");

  // Distinct model → drop old engine
  if (engine && engineModelId !== modelId) {
    try {
      await engine.unload?.();
    } catch {}
    engine = null;
    engineModelId = null;
  }
  engineModelId = modelId;

  loading = (async () => {
    const mod: any = await import("@mlc-ai/web-llm");
    const CreateMLCEngine = mod.CreateMLCEngine ?? mod.default?.CreateMLCEngine;
    if (!CreateMLCEngine) throw new Error("WebLLM runtime failed to load");
    const eng = await CreateMLCEngine(modelId, {
      logLevel: "WARN",
      initProgressCallback: (report: any) => {
        onProgress?.({ progress: report?.progress ?? 0, text: report?.text ?? "loading…" });
      },
    });
    engine = eng;
    try {
      localStorage.setItem("af_arcade_model_ready", modelId);
    } catch {}
    return eng;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export function modelReadyOffline(): string | null {
  try {
    return localStorage.getItem("af_arcade_model_ready");
  } catch {
    return null;
  }
}

export interface GenOpts {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (t: string, count: number) => void;
}

export async function generateCode(opts: GenOpts): Promise<{ text: string; tokens: number; ms: number; tokps: number }> {
  if (!engine) throw new Error("engine not loaded");
  const started = Date.now();
  try {
    await engine.resetChat?.();
  } catch {}
  const stream = await engine.chat.completions.create({
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 6000,
    stream: true,
  });
  let text = "";
  let count = 0;
  for await (const chunk of stream) {
    if (opts.signal?.aborted) break;
    const delta: string = chunk?.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      text += delta;
      count++;
      opts.onToken?.(delta, count);
    }
  }
  const ms = Date.now() - started;
  return { text, tokens: count, ms, tokps: ms > 0 ? Math.round((count / ms) * 1000 * 10) / 10 : 0 };
}
