/**
 * Model Hub — runtime detection, download catalog, and routing ids.
 *
 * The hub connects LOCAL OpenAI-compatible inference servers (Ollama, LM
 * Studio, llama.cpp) to the whole app: their models become first-class
 * registry entries selectable in chat, battles, council, and collab.
 *
 * SECURITY: every base URL the hub will contact is gated by assertLoopbackUrl
 * — the server process must never be turned into an SSRF proxy. Loopback
 * only by default; private LAN ranges require MODEL_HUB_ALLOW_LAN=1. Public
 * hosts are always refused (the BYOK cloud providers are the sanctioned
 * remote path, with their own code).
 */

import type { FreeModel } from "@/lib/models";

export type RuntimeKind = "ollama" | "lmstudio" | "llamacpp" | "openai-compat";

export type RuntimeProbe = {
  kind: RuntimeKind;
  baseUrl: string;
  online: boolean;
  models: string[];
  detail: string;
};

const PRIVATE_IPV4 = /^10\./;
const PRIVATE_1928 = /^192\.168\./;
const PRIVATE_172 = /^172\.(1[6-9]|2\d|3[01])\./;

/** Loopback (and optionally LAN) gate for every URL the hub contacts. */
export function assertLoopbackUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model Hub URLs must be http(s).");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  if (isLoopback) return url;
  if (process.env.MODEL_HUB_ALLOW_LAN === "1" &&
      (PRIVATE_IPV4.test(host) || PRIVATE_1928.test(host) || PRIVATE_172.test(host))) {
    return url;
  }
  throw new Error(
    "Model Hub can only talk to servers on this machine (127.0.0.1). " +
    "Set MODEL_HUB_ALLOW_LAN=1 to also allow private-network runtimes.",
  );
}

/** Routing id for a model served by a local server (self-contained: generate()
 *  needs no DB to route). __server__:<base>:<model>, both parts encoded. */
export function serverRoutingId(baseUrl: string, remoteModel: string): string {
  return `__server__:${encodeURIComponent(baseUrl.replace(/\/$/, ""))}:${encodeURIComponent(remoteModel)}`;
}

export function parseServerRoutingId(id: string): { baseUrl: string; remoteModel: string } | null {
  if (!id.startsWith("__server__:")) return null;
  const rest = id.slice("__server__:".length);
  const split = rest.indexOf(":");
  if (split === -1) return null;
  try {
    return {
      baseUrl: decodeURIComponent(rest.slice(0, split)),
      remoteModel: decodeURIComponent(rest.slice(split + 1)),
    };
  } catch {
    return null;
  }
}

/** Short slug for a hub model id: hub:<kind>:<model-without-tags>. */
export function hubModelId(kind: string, remoteModel: string): string {
  const simplified = remoteModel.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  return `hub:${kind}:${simplified}`;
}

const PROBE_TIMEOUT_MS = 2500;

/** Probe one base URL and classify it by what answers. */
export async function probeRuntime(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeProbe> {
  const base = baseUrl.replace(/\/$/, "");
  const withTimeout = async (path: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      return await fetchImpl(`${base}${path}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // Ollama answers /api/tags with { models: [{ name, size }] }.
  try {
    const res = await withTimeout("/api/tags");
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { models?: Array<{ name?: unknown }> };
      const models = (body.models ?? [])
        .map((m) => (typeof m.name === "string" ? m.name : ""))
        .filter((name) => name !== "");
      return { kind: "ollama", baseUrl: base, online: true, models, detail: `Ollama · ${models.length} model${models.length === 1 ? "" : "s"} installed` };
    }
  } catch {
    /* not ollama */
  }

  // OpenAI-compatible /v1/models (Ollama also serves this, LM Studio, llama.cpp).
  try {
    const res = await withTimeout("/v1/models");
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter((id) => id !== "");
      const port = new URL(base).port;
      const kind: RuntimeKind = port === "1234" ? "lmstudio" : port === "8080" ? "llamacpp" : "openai-compat";
      return { kind, baseUrl: base, online: true, models, detail: `OpenAI-compatible · ${models.length} model${models.length === 1 ? "" : "s"}` };
    }
  } catch {
    /* not openai-compat */
  }

  return { kind: "openai-compat", baseUrl: base, online: false, models: [], detail: "no runtime answered" };
}

/** Ports scanned by default (Ollama, LM Studio, llama.cpp server). */
export const DEFAULT_SCAN_PORTS = [11434, 1234, 8080];

/** Curated Ollama pull catalog — real library tags, honestly sized. */
export type PullCatalogEntry = {
  tag: string;
  name: string;
  /** Approximate download size. */
  sizeGb: number;
  minRamGb: number;
  description: string;
};

export const PULL_CATALOG: readonly PullCatalogEntry[] = [
  { tag: "tinyllama", name: "TinyLlama 1.1B", sizeGb: 0.6, minRamGb: 2, description: "Smallest useful chat model — runs on anything." },
  { tag: "llama3.2:1b", name: "Llama 3.2 1B", sizeGb: 1.3, minRamGb: 4, description: "Meta's compact model. Fast general chat on modest hardware." },
  { tag: "llama3.2:3b", name: "Llama 3.2 3B", sizeGb: 2.0, minRamGb: 6, description: "The quality step up — good general assistant, still CPU-friendly." },
  { tag: "gemma2:2b", name: "Gemma 2 2B", sizeGb: 1.6, minRamGb: 4, description: "Google's compact model — strong writing for its size." },
  { tag: "qwen2.5:3b", name: "Qwen 2.5 3B", sizeGb: 1.9, minRamGb: 6, description: "Alibaba's model — good coding + multilingual for the size." },
  { tag: "qwen2.5:7b", name: "Qwen 2.5 7B", sizeGb: 4.7, minRamGb: 10, description: "Serious coding and reasoning; best with 8GB+ VRAM or patience." },
  { tag: "deepseek-r1:7b", name: "DeepSeek R1 7B", sizeGb: 4.7, minRamGb: 10, description: "Reasoning model — shows its thinking; strong at math and logic." },
  { tag: "mistral:7b", name: "Mistral 7B", sizeGb: 4.1, minRamGb: 10, description: "The classic efficient 7B — balanced general use." },
];

/** Build the registry entry (FreeModel) for a local-server model. */
export function hubModelFor(
  kind: RuntimeKind,
  baseUrl: string,
  remoteModel: string,
  connectionLabel: string,
): FreeModel {
  const host = new URL(baseUrl).host;
  return {
    id: hubModelId(kind, remoteModel),
    name: `${remoteModel} (${kind})`,
    provider: `local · ${connectionLabel || host}`,
    description: `Runs on your machine through ${connectionLabel || host} (${kind}). Real local inference — nothing leaves this computer.`,
    strengths: ["Offline", "Private", "Local"],
    speed: "medium",
    quality: 4,
    level: "on-device",
    backend: "local-server",
    requiresNetwork: false,
    requiresKey: false,
    requiresDownload: true,
    pollinationsId: serverRoutingId(baseUrl, remoteModel),
    emoji: "🦙",
    color: "#38bdf8",
    kind: "text",
  };
}

/** Parse one NDJSON line of an Ollama pull stream. */
export function parsePullLine(line: string): { status?: string; digest?: string; total?: number; completed?: number } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as { status?: string; digest?: string; total?: number; completed?: number };
  } catch {
    return null;
  }
}
