// Client for the WanGP bridge (bridges/wangp_bridge.py).
//
// The bridge is a tiny dependency-free HTTP server you run next to your
// WanGP install. It wraps WanGP's official Python API (shared/api.py) and
// exposes it as JSON. WanGP itself requires a CUDA GPU (6GB+ VRAM);
// when the bridge is not reachable the Studio falls back to demo mode.
//
// WanGP is by DeepBeepMeep — https://github.com/deepbeepmeep/Wan2GP

import type { BackendJobSnapshot, StudioModelDetail, StudioModelInfo } from "./types";

export function defaultWangpUrl(): string {
  return process.env.WANGP_BRIDGE_URL || "http://127.0.0.1:7862";
}

async function jfetch<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail = String(body.error);
      } catch {
        /* ignore */
      }
      throw new Error(`wangp-bridge ${detail}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export interface WangpHealth {
  ok: boolean;
  backend: "wangp";
  mock?: boolean;
  wangp_version?: string;
  bridge_version?: string;
  models?: number;
  queue?: number;
}

export async function wangpHealth(url = defaultWangpUrl()): Promise<WangpHealth> {
  return jfetch<WangpHealth>(`${url.replace(/\/$/, "")}/health`, undefined, 2500);
}

export async function wangpModels(
  modality: "video" | "image" | "audio" | undefined,
  url = defaultWangpUrl()
): Promise<StudioModelInfo[]> {
  const q = modality ? `?main_output=${encodeURIComponent(modality)}` : "";
  const data = await jfetch<{ models: any[] }>(`${url.replace(/\/$/, "")}/models${q}`);
  return (data.models || []).map((m) => ({
    modelType: String(m.model_type),
    name: String(m.name || m.model_type),
    modality: normalizeModality(m.main_output || m.outputs?.[0]),
    outputs: m.outputs ?? [],
    family: m.family,
    familyLabel: m.family_label,
    description: m.description ?? m.notes ?? "",
    minVram: typeof m.min_vram === "number" ? m.min_vram : undefined,
    available: typeof m.available === "boolean" ? m.available : undefined,
    source: "wangp",
  }));
}

function normalizeModality(v: unknown): "video" | "image" | "audio" {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("video")) return "video";
  if (s.includes("image")) return "image";
  if (s.includes("audio")) return "audio";
  return "video";
}

export async function wangpModelDetail(
  modelType: string,
  url = defaultWangpUrl()
): Promise<StudioModelDetail> {
  const data = await jfetch<any>(`${url.replace(/\/$/, "")}/model/${encodeURIComponent(modelType)}`);
  return {
    modelType: String(data.model_type),
    name: String(data.name || data.model_type),
    modality: normalizeModality(data.schema?.main_output?.[0] ?? data.defaults?.model_type),
    source: "wangp",
    defaults: data.defaults ?? undefined,
    schema: data.schema ?? undefined,
    availability: data.availability ?? undefined,
  };
}

export async function wangpSubmit(
  settings: Record<string, unknown>,
  url = defaultWangpUrl()
): Promise<string> {
  const data = await jfetch<{ job_id: string }>(`${url.replace(/\/$/, "")}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!data.job_id) throw new Error("bridge returned no job id");
  return data.job_id;
}

export async function wangpJob(jobId: string, url = defaultWangpUrl()): Promise<BackendJobSnapshot> {
  const j = await jfetch<any>(`${url.replace(/\/$/, "")}/jobs/${encodeURIComponent(jobId)}`);
  const files = (j.files || []).map((f: any) => ({
    name: String(f.name || "output"),
    mediaType: String(f.media_type || f.mime || "application/octet-stream"),
    kind: normalizeModality(f.media_type || f.mime || "video"),
    size: typeof f.size === "number" ? f.size : undefined,
  }));
  return {
    status: normalizeStatus(j.status),
    phase: String(j.phase || ""),
    progress: clamp01(Number(j.progress)),
    files,
    error: j.errors?.[0]?.message || j.error || undefined,
    preview: typeof j.preview === "string" && j.preview.startsWith("data:") ? j.preview : null,
  };
}

function normalizeStatus(s: unknown): BackendJobSnapshot["status"] {
  switch (String(s).toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    case "running":
      return "running";
    default:
      return "queued";
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // bridge reports 0..1 (float) — be tolerant of 0..100
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

export async function wangpCancel(jobId: string, url = defaultWangpUrl()): Promise<void> {
  await jfetch(`${url.replace(/\/$/, "")}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

// Stream a generated file (supports HTTP Range for <video> seeking).
export async function wangpFile(
  jobId: string,
  file: string,
  range: string | null,
  url = defaultWangpUrl()
): Promise<Response> {
  const target = `${url.replace(/\/$/, "")}/files/${encodeURIComponent(jobId)}/${encodeURIComponent(file)}`;
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  return fetch(target, { headers });
}
