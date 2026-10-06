/**
 * Generation seam with an explicit runtime contract.
 *
 * Every result states WHAT ACTUALLY EXECUTED:
 *
 *   { text, runtimeLevel, backend, provider, modelId, requestedModelId, via, ms/latencyMs, firstTokenMs?, fallback, fallbackFrom?, fallbackReason?, note? }
 *
 * Tiers (lib/runtime.ts):
 *   local-engine — deterministic offline engine (NOT an LLM). No network.
 *   local-llm    — real on-device inference (TurboAgent server; WebLLM runs
 *                  in the browser and cannot be executed by server routes).
 *   remote-free  — real provider-backed inference over the network.
 *
 * Fallbacks are never invisible: when a selected runtime cannot run, the
 * Local Engine answers with fallback=true, fallbackFrom naming the request,
 * and a visible notice appended to the text. Remote output is never
 * displayed under a Local Engine badge and vice versa.
 */

import { getModel } from "./models";
import { LOCAL_ENGINE_ID, type Backend, type RuntimeLevel } from "./models";
import { localImageDataURI, localTextReply } from "./localEngine";
import { NO_TRAIN_HEADERS } from "./privacy";
import type { GenerateResult, RuntimeExecution } from "./runtime";
import { BACKEND_PROVIDER, localEngineResult } from "./runtime";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOpts {
  modelId: string;
  messages: ChatMsg[];
  temperature?: number;
  system?: string;
  /** Output cap for text completions. Providers that support it pass it
   *  through as max_tokens — prevents silent truncation of long code. */
  maxTokens?: number;
  imageSize?: string; // e.g. "768x768" for image-kind models
  category?: string;
  // Privacy: localOnly forces the offline engine (zero network egress).
  // If the selected model is NOT the Local Engine, the result is an honest,
  // clearly-labelled fallback.
  localOnly?: boolean;
  // Optional user-supplied keys (BYOK) — sent from client, never stored
  keys?: {
    openrouter?: string;
    groq?: string;
    gemini?: string;
    turboagent?: string;
  };
}

/** Injectable execution dependencies — tests use these to exercise each
 *  backend without real network access. */
export interface GenerateDeps {
  fetchImpl?: typeof fetch;
  // WebLLM executes in the browser (WebGPU). Server routes cannot run it;
  // an injected executor lets clients/tests prove the contract.
  webllmExecutor?: (mlcModelId: string, messages: ChatMsg[], temperature: number) => Promise<string>;
}

export type { GenerateResult };

const FALLBACK_NOTICE = (requested: string, reason: string) =>
  `\n\n---\n⚠️ **Fallback: Local Engine** — ${requested} was unavailable (${reason}). The answer above is deterministic offline output, **not** model output.`;

function requestedExecution(modelId: string, backend: Backend, level: RuntimeLevel): RuntimeExecution {
  return { runtimeLevel: level, backend, modelId };
}

async function tryTurboAgent(
  fetchImpl: typeof fetch,
  url: string,
  modelId: string,
  messages: ChatMsg[],
  temperature: number,
  maxTokens?: number,
  timeoutMs = 60000,
): Promise<string> {
  const base = url.replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NO_TRAIN_HEADERS },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens ?? 2048,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`turboagent ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) throw new Error("turboagent empty");
    return String(text);
  } finally {
    clearTimeout(t);
  }
}

async function tryPollinationsOpenAI(
  fetchImpl: typeof fetch,
  pollinationsId: string,
  messages: ChatMsg[],
  temperature: number,
  maxTokens?: number,
  timeoutMs = 45000,
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NO_TRAIN_HEADERS },
      body: JSON.stringify({
        model: pollinationsId,
        messages,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`pollinations-openai ${res.status}`);
    const data = await res.json();
    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      (typeof data === "string" ? data : "");
    if (!text || !String(text).trim()) throw new Error("empty completion");
    return String(text);
  } finally {
    clearTimeout(t);
  }
}

async function tryPollinationsGet(
  fetchImpl: typeof fetch,
  prompt: string,
  pollinationsId: string,
  system: string | undefined,
  timeoutMs = 45000,
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`);
    url.searchParams.set("model", pollinationsId);
    if (system) url.searchParams.set("system", system);
    const res = await fetchImpl(url.toString(), {
      signal: ctrl.signal,
      headers: { ...NO_TRAIN_HEADERS },
    });
    if (!res.ok) throw new Error(`pollinations-get ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error("empty get completion");
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function tryOpenRouter(
  fetchImpl: typeof fetch,
  key: string,
  messages: ChatMsg[],
  temperature: number,
  maxTokens?: number,
): Promise<string> {
  const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://arenaforge.local",
      "X-Title": "ArenaForge Personal",
      ...NO_TRAIN_HEADERS,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.3-70b-instruct:free",
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("openrouter empty");
  return String(text);
}

async function tryGroq(
  fetchImpl: typeof fetch,
  key: string,
  messages: ChatMsg[],
  temperature: number,
  maxTokens?: number,
): Promise<string> {
  const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...NO_TRAIN_HEADERS,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("groq empty");
  return String(text);
}

function localImage(
  modelId: string,
  opts: GenerateOpts,
  style: "flux" | "turbo",
): { text: string; seed: number } {
  const lastUser =
    [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "a beautiful landscape";
  const [w, h] = (opts.imageSize ?? "768x768")
    .split("x")
    .map((n) => Math.min(1280, Math.max(256, Number(n) || 768)));
  const seed = Math.floor(Math.random() * 999999);
  const uri = localImageDataURI(lastUser.slice(0, 200), seed, w, h, style);
  return {
    text: `![local procedural image](${uri})\n\n*🎨 Local Canvas · 🔒 deterministic offline art (not model generation) · seed ${seed}*`,
    seed,
  };
}

async function generateExec(opts: GenerateOpts, deps: GenerateDeps = {}): Promise<GenerateResult> {
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = getModel(opts.modelId);
  const temperature = opts.temperature ?? 0.7;
  const system = opts.system?.trim();
  const ms = () => Date.now() - started;

  const fullMessages: ChatMsg[] = system
    ? [{ role: "system", content: system }, ...opts.messages.filter((m) => m.role !== "system")]
    : opts.messages;

  // ---------------- LOCAL ENGINE (tier 1) ----------------
  // The built-in deterministic engine. Selected directly, or reached as the
  // honest fallback for localOnly requests that named another runtime.
  const runLocalEngine = (via: string, extra?: Parameters<typeof localEngineResult>[3]) =>
    localEngineResult(
      localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general"),
      via,
      ms(),
      extra,
    );

  if (model.level === "arena-local") {
    if (model.kind === "image") {
      const { text } = localImage(model.id, opts, "flux");
      return localEngineResult(text, "local:image", ms());
    }
    return runLocalEngine(opts.localOnly ? "offline" : "offline");
  }

  // localOnly + a non-local-engine selection → forced, visible fallback.
  if (opts.localOnly) {
    if (model.kind === "image") {
      const style = model.pollinationsId.split(":")[1] === "turbo" ? "turbo" : "flux";
      const { text } = localImage(model.id, opts, style);
      return localEngineResult(text, "offline-fallback", ms(), {
        fallback: true,
        fallbackFrom: requestedExecution(model.id, model.backend, model.level),
        note: "Local Mode is on — remote image generation was not attempted.",
      });
    }
    return localEngineResult(
      localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
        FALLBACK_NOTICE(model.name, "Local Mode is on — no network egress is allowed"),
      "offline-fallback",
      ms(),
      {
        fallback: true,
        fallbackFrom: requestedExecution(model.id, model.backend, model.level),
        note: "Local Mode forces the offline engine.",
      },
    );
  }

  // ---------------- IMAGE models (remote) ----------------
  if (model.pollinationsId.startsWith("__image__")) {
    const imgModel = model.pollinationsId.split(":")[1] || "flux";
    const lastUser =
      [...fullMessages].reverse().find((m) => m.role === "user")?.content ?? "a beautiful landscape";
    const [w, h] = (opts.imageSize ?? "768x768")
      .split("x")
      .map((n) => Math.min(1280, Math.max(256, Number(n) || 768)));
    const seed = Math.floor(Math.random() * 999999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      lastUser.slice(0, 600),
    )}?model=${imgModel}&width=${w}&height=${h}&nologo=true&enhance=true&seed=${seed}`;
    return {
      text: `![generated image](${url})\n\n*🎨 ${model.name} · ☁ remote free tier · seed ${seed}*`,
      runtimeLevel: "remote",
      backend: "pollinations",
      modelId: model.id,
      via: `pollinations-image:${imgModel}`,
      ms: ms(),
      fallback: false,
    };
  }

  // ---------------- LOCAL LLM (tier 2) ----------------
  if (model.backend === "turboagent") {
    const hfId = decodeURIComponent(model.pollinationsId.split(":")[1] || "Qwen/Qwen2.5-32B-Instruct");
    const url = opts.keys?.turboagent?.trim() || process.env.TURBOAGENT_URL || "";
    const wanted = requestedExecution(model.id, model.backend, model.level);
    if (url) {
      try {
        const text = await tryTurboAgent(fetchImpl, url, hfId, fullMessages, temperature, opts.maxTokens);
        return {
          text,
          runtimeLevel: "on-device",
          backend: "turboagent",
          modelId: model.id,
          via: `turboagent:${hfId}`,
          ms: ms(),
          fallback: false,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unreachable";
        return localEngineResult(
          localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
            FALLBACK_NOTICE(`${model.name} (${url})`, reason),
          "offline-fallback",
          ms(),
          { fallback: true, fallbackFrom: wanted, note: `TurboAgent unreachable: ${reason}` },
        );
      }
    }
    return localEngineResult(
      localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
        FALLBACK_NOTICE(model.name, "no TurboAgent server configured — start one with `turboagent serve` and add its URL in AI Runtime"),
      "offline-fallback",
      ms(),
      { fallback: true, fallbackFrom: wanted, note: "TurboAgent not configured." },
    );
  }

  if (model.backend === "webllm") {
    const mlcId = decodeURIComponent(model.pollinationsId.split(":")[1] ?? "");
    const wanted = requestedExecution(model.id, model.backend, model.level);
    if (deps.webllmExecutor) {
      try {
        const text = await deps.webllmExecutor(mlcId, fullMessages, temperature);
        return {
          text,
          runtimeLevel: "on-device",
          backend: "webllm",
          modelId: model.id,
          via: `webllm:${mlcId}`,
          ms: ms(),
          fallback: false,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "execution failed";
        return localEngineResult(
          localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
            FALLBACK_NOTICE(model.name, reason),
          "offline-fallback",
          ms(),
          { fallback: true, fallbackFrom: wanted, note: `WebLLM failed: ${reason}` },
        );
      }
    }
    // WebLLM runs in the browser (WebGPU); server-side routes cannot load
    // weights. Say so honestly instead of pretending.
    return localEngineResult(
      localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
        FALLBACK_NOTICE(model.name, "WebLLM executes in your browser (WebGPU) — server-side routes cannot run it"),
      "offline-fallback",
      ms(),
      { fallback: true, fallbackFrom: wanted, note: "WebLLM is browser-only." },
    );
  }

  // ---------------- REMOTE FREE (tier 3) ----------------
  const wanted = requestedExecution(model.id, "pollinations", "remote");
  const lastUser = [...fullMessages].reverse().find((m) => m.role === "user")?.content ?? "Hello";

  // BYOK providers first (still remote-free tier; keys user-supplied).
  if (opts.keys?.openrouter) {
    try {
      const text = await tryOpenRouter(fetchImpl, opts.keys.openrouter, fullMessages, temperature, opts.maxTokens);
      return {
        text,
        runtimeLevel: "remote",
        backend: "openrouter",
        modelId: model.id,
        via: "openrouter:free",
        ms: ms(),
        fallback: false,
      };
    } catch {
      /* fall through */
    }
  }
  if (opts.keys?.groq) {
    try {
      const text = await tryGroq(fetchImpl, opts.keys.groq, fullMessages, temperature, opts.maxTokens);
      return {
        text,
        runtimeLevel: "remote",
        backend: "groq",
        modelId: model.id,
        via: "groq:free",
        ms: ms(),
        fallback: false,
      };
    } catch {
      /* fall through */
    }
  }

  // Pollinations OpenAI-compatible endpoint, then GET style, then the
  // most-reliable alias. Every failure is recorded for the honest fallback.
  let lastReason = "no route succeeded";
  try {
    const text = await tryPollinationsOpenAI(fetchImpl, model.pollinationsId, fullMessages, temperature, opts.maxTokens);
    return {
      text,
      runtimeLevel: "remote",
      backend: "pollinations",
      modelId: model.id,
      via: `pollinations:${model.pollinationsId}`,
      ms: ms(),
      fallback: false,
    };
  } catch (error) {
    lastReason = error instanceof Error ? error.message : "openai route failed";
  }
  try {
    const convo = fullMessages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const text = await tryPollinationsGet(fetchImpl, convo || lastUser, model.pollinationsId, system);
    return {
      text,
      runtimeLevel: "remote",
      backend: "pollinations",
      modelId: model.id,
      via: `pollinations-get:${model.pollinationsId}`,
      ms: ms(),
      fallback: false,
    };
  } catch (error) {
    lastReason = error instanceof Error ? error.message : lastReason;
  }
  if (model.pollinationsId !== "openai") {
    try {
      const text = await tryPollinationsOpenAI(fetchImpl, "openai", fullMessages, temperature, 30000);
      return {
        text,
        runtimeLevel: "remote",
        backend: "pollinations",
        modelId: model.id,
        via: "pollinations:openai-fallback",
        ms: ms(),
        fallback: false,
        note: "Requested model was unavailable; answered by the provider's openai route.",
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : lastReason;
    }
  }

  // Guaranteed offline answer — visible, labelled, never branded as the model.
  return localEngineResult(
    localTextReply(LOCAL_ENGINE_ID, fullMessages, system, opts.category ?? "general") +
      FALLBACK_NOTICE(model.name, lastReason),
    "offline-fallback",
    ms(),
    { fallback: true, fallbackFrom: wanted, note: `Remote unavailable: ${lastReason}` },
  );
}

/**
 * The public generation seam. Wraps generateExec so EVERY result — from every
 * backend, every fallback path — carries the full contract: provider identity,
 * what was requested, measured latency (ms + latencyMs alias), and a
 * machine-usable fallbackReason. Callers can rely on these fields existing.
 */
export async function generate(opts: GenerateOpts, deps: GenerateDeps = {}): Promise<GenerateResult> {
  const r = await generateExec(opts, deps);
  const enriched: GenerateResult = {
    ...r,
    provider: r.provider ?? BACKEND_PROVIDER[r.backend],
    requestedModelId: r.requestedModelId ?? opts.modelId,
    latencyMs: r.ms,
    fallbackReason: r.fallback ? (r.fallbackReason ?? r.note ?? "unavailable") : undefined,
  };
  return enriched;
}
