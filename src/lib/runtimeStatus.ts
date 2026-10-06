/**
 * Unified runtime status — runtime-DETECTED availability, never inferred from
 * catalog metadata. Server-side probes (with injectable fetch for tests) +
 * browser-side checks (WebGPU/WebLLM via lib/webllm).
 */

import type { ExecutionStatus } from "./runtime";

export interface BackendProbe {
  backend: "turboagent" | "pollinations" | "openrouter" | "groq";
  status: ExecutionStatus;
  detail: string;
  latencyMs?: number;
  checkedAt: string;
}

export interface RuntimeStatusReport {
  checkedAt: string;
  probes: BackendProbe[];
  notes: string[];
}

const PROBE_TIMEOUT_MS = 6000;

async function probe(
  fetchImpl: typeof fetch,
  backend: BackendProbe["backend"],
  url: string,
  init?: RequestInit,
): Promise<BackendProbe> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return { backend, status: "connected", detail: `HTTP ${res.status}`, latencyMs, checkedAt: new Date().toISOString() };
    }
    return { backend, status: "provider-error", detail: `HTTP ${res.status}`, latencyMs, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    const latencyMs = Date.now() - started;
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message ?? "connection failed");
    return {
      backend,
      status: backend === "turboagent" ? "server-unavailable" : "network-unavailable",
      detail: reason,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the locally-configurable backends. TurboAgent URL comes from the
 * request body (client-side localStorage) or the server env. Pollinations is
 * probed directly. OpenRouter/Groq are BYOK — without a key they are
 * "api-key-required", and keys never touch the server probe (client-only).
 */
export async function probeRuntimeStatus(
  fetchImpl: typeof fetch,
  opts: { turboagentUrl?: string | null } = {},
): Promise<RuntimeStatusReport> {
  const probes: BackendProbe[] = [];
  const notes: string[] = [];

  const turboUrl = (opts.turboagentUrl ?? process.env.TURBOAGENT_URL ?? "").trim();
  if (turboUrl) {
    probes.push(await probe(fetchImpl, "turboagent", `${turboUrl.replace(/\/$/, "")}/v1/models`));
  } else {
    probes.push({
      backend: "turboagent",
      status: "unavailable",
      detail: "not configured — start one with `turboagent serve` and add its URL",
      checkedAt: new Date().toISOString(),
    });
  }

  probes.push(await probe(fetchImpl, "pollinations", "https://text.pollinations.ai/models"));

  notes.push("OpenRouter/Groq are BYOK: status is api-key-required until a key is set in your browser (keys stay client-side).");
  notes.push("WebLLM runs only in a WebGPU-capable browser — check /runtime for local detection.");

  return { checkedAt: new Date().toISOString(), probes, notes };
}
