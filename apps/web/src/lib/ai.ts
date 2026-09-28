import { getModel } from "./models";
import { localImageDataURI, localTextReply } from "./localEngine";
import { NO_TRAIN_HEADERS } from "./privacy";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOpts {
  modelId: string;
  messages: ChatMsg[];
  temperature?: number;
  system?: string;
  imageSize?: string; // e.g. "768x768" for image-kind models
  category?: string;
  // Privacy: localOnly forces the on-device engine (zero network egress).
  // No request content leaves the machine when true.
  localOnly?: boolean;
  // Optional user-supplied keys (BYOK) — sent from client, never stored
  keys?: {
    openrouter?: string;
    groq?: string;
    gemini?: string;
  };
}

async function tryPollinationsOpenAI(
  pollinationsId: string,
  messages: ChatMsg[],
  temperature: number,
  timeoutMs = 45000
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NO_TRAIN_HEADERS },
      body: JSON.stringify({
        model: pollinationsId,
        messages,
        temperature,
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
  prompt: string,
  pollinationsId: string,
  system: string | undefined,
  timeoutMs = 45000
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`);
    url.searchParams.set("model", pollinationsId);
    if (system) url.searchParams.set("system", system);
    const res = await fetch(url.toString(), {
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
  key: string,
  messages: ChatMsg[],
  temperature: number
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("openrouter empty");
  return String(text);
}

async function tryGroq(key: string, messages: ChatMsg[], temperature: number): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("groq empty");
  return String(text);
}

export async function generate(opts: GenerateOpts): Promise<{ text: string; via: string; ms: number }> {
  const started = Date.now();
  const model = getModel(opts.modelId);
  const temperature = opts.temperature ?? 0.7;
  const system = opts.system?.trim();

  // ---------- LOCAL MODE: zero egress ----------
  if (opts.localOnly) {
    if (model.pollinationsId.startsWith("__image__")) {
      const style = model.pollinationsId.split(":")[1] === "turbo" ? "turbo" : "flux";
      const lastUser =
        [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "a beautiful landscape";
      const [w, h] = (opts.imageSize ?? "768x768")
        .split("x")
        .map((n) => Math.min(1280, Math.max(256, Number(n) || 768)));
      const seed = Math.floor(Math.random() * 999999);
      const uri = localImageDataURI(lastUser.slice(0, 200), seed, w, h, style);
      return {
        text: `![local procedural image](${uri})\n\n*🎨 ${model.name} · 🔒 local canvas (offline procedural art) · seed ${seed}*`,
        via: "local:image",
        ms: Date.now() - started,
      };
    }
    const fullMessages: ChatMsg[] = system
      ? [{ role: "system", content: system }, ...opts.messages.filter((m) => m.role !== "system")]
      : opts.messages;
    return {
      text: localTextReply(opts.modelId, fullMessages, system, opts.category ?? "general"),
      via: "local:text",
      ms: Date.now() - started,
    };
  }

  // Image-kind models → URL-built generation (browser renders the image async).
  // Free, keyless, instant — powers the Image Arena.
  if (model.pollinationsId.startsWith("__image__")) {
    const imgModel = model.pollinationsId.split(":")[1] || "flux";
    const lastUser =
      [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "a beautiful landscape";
    const [w, h] = (opts.imageSize ?? "768x768")
      .split("x")
      .map((n) => Math.min(1280, Math.max(256, Number(n) || 768)));
    const seed = Math.floor(Math.random() * 999999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      lastUser.slice(0, 600)
    )}?model=${imgModel}&width=${w}&height=${h}&nologo=true&enhance=true&seed=${seed}`;
    return {
      text: `![generated image](${url})\n\n*🎨 ${model.name} · free tier · seed ${seed}*`,
      via: `pollinations-image:${imgModel}`,
      ms: Date.now() - started,
    };
  }

  const fullMessages: ChatMsg[] = system
    ? [{ role: "system", content: system }, ...opts.messages.filter((m) => m.role !== "system")]
    : opts.messages;

  // Offline model → straight to local generator
  if (model.pollinationsId === "__offline__") {
    return {
      text: localTextReply(opts.modelId, fullMessages, system, opts.category ?? "general"),
      via: "offline",
      ms: Date.now() - started,
    };
  }

  const lastUser = [...fullMessages].reverse().find((m) => m.role === "user")?.content ?? "Hello";

  // 1) BYOK providers first (better quality if user pasted a free key).
  // NOTE: third-party free tiers may log for abuse-prevention; Local Mode avoids them entirely.
  if (opts.keys?.openrouter) {
    try {
      const text = await tryOpenRouter(opts.keys.openrouter, fullMessages, temperature);
      return { text, via: "openrouter:free", ms: Date.now() - started };
    } catch {
      /* fall through */
    }
  }
  if (opts.keys?.groq) {
    try {
      const text = await tryGroq(opts.keys.groq, fullMessages, temperature);
      return { text, via: "groq:free", ms: Date.now() - started };
    } catch {
      /* fall through */
    }
  }

  // 2) Pollinations OpenAI-compatible endpoint
  try {
    const text = await tryPollinationsOpenAI(model.pollinationsId, fullMessages, temperature);
    return { text, via: `pollinations:${model.pollinationsId}`, ms: Date.now() - started };
  } catch {
    /* fall through to GET style */
  }

  // 3) Pollinations GET style (most compatible)
  try {
    const convo = fullMessages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const text = await tryPollinationsGet(convo || lastUser, model.pollinationsId, system);
    return { text, via: `pollinations-get:${model.pollinationsId}`, ms: Date.now() - started };
  } catch {
    /* fall through */
  }

  // 4) Try plain 'openai' alias as last cloud attempt (most reliable)
  if (model.pollinationsId !== "openai") {
    try {
      const text = await tryPollinationsOpenAI("openai", fullMessages, temperature, 30000);
      return { text, via: "pollinations:openai-fallback", ms: Date.now() - started };
    } catch {
      /* fall through */
    }
  }

  // 5) Guaranteed offline answer — app never hard-fails
  return {
    text: localTextReply(opts.modelId, fullMessages, system, opts.category ?? "general"),
    via: "offline-fallback",
    ms: Date.now() - started,
  };
}
