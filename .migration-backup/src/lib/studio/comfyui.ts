// ComfyUI backend client.
//
// Talks to any ComfyUI server's HTTP API:
//   POST /prompt            → submit an API-format workflow, get prompt_id
//   GET  /history/{id}      → outputs + status once finished
//   GET  /queue             → running/pending queue (progress hints, cancel)
//   POST /queue {delete:[]} → cancel
//   GET  /view?filename=..  → fetch generated output files
//
// Compatible with Wan 2.1/2.2 (native nodes), LTX-Video, and anything else
// you can build in ComfyUI — including the Wan2GP ComfyUI custom nodes.
// Use built-in workflow templates or paste your own exported workflow
// (File → Export Workflow (API)) with {{PLACEHOLDER}} tokens.

import type { BackendJobSnapshot, StudioModelInfo } from "./types";
import { COMFY_TEMPLATES, findComfyTemplate } from "./catalog";

export function defaultComfyUrl(): string {
  return process.env.COMFYUI_URL || "http://127.0.0.1:8188";
}

const base = (url: string) => url.replace(/\/$/, "");

async function jfetch<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`comfyui ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function comfyHealth(url = defaultComfyUrl()): Promise<{ ok: boolean; version?: string }> {
  const stats = await jfetch<any>(`${base(url)}/system_stats`, undefined, 2500);
  return { ok: true, version: stats?.system?.comfyui_version ?? undefined };
}

// ---- template variable substitution ----

export interface TemplateVars {
  PROMPT: string;
  NEGATIVE: string;
  SEED: number;
  WIDTH: number;
  HEIGHT: number;
  LENGTH: number;
  STEPS: number;
  CFG: number;
  FPS: number;
  [k: string]: unknown;
}

function substitute(node: unknown, vars: TemplateVars): unknown {
  if (typeof node === "string") {
    const exact = node.match(/^\{\{(\w+)\}\}$/);
    if (exact) {
      const v = vars[exact[1]];
      return v === undefined ? node : v;
    }
    // inline substitution (prompt text inside longer strings)
    return node.replace(/\{\{(\w+)\}\}/g, (m, key) => {
      const v = vars[key];
      return v === undefined ? m : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, vars));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = substitute(v, vars);
    return out;
  }
  return node;
}

export function applyTemplateVars(workflow: Record<string, unknown>, vars: TemplateVars): Record<string, unknown> {
  return substitute(workflow, vars) as Record<string, unknown>;
}

// Parse a pasted workflow. Accepts raw JSON (object or string with {{tokens}}).
export function parseWorkflowJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow JSON must be an object of nodes (API format)");
  }
  return parsed;
}

// ---- models (template-driven; ComfyUI's real node graph is user-side) ----

export function comfyModels(modality?: string): StudioModelInfo[] {
  return COMFY_TEMPLATES.filter((t) => !modality || t.modality === modality).map((t) => ({
    modelType: `comfy:${t.id}`,
    name: `${t.name} · ComfyUI`,
    modality: t.modality,
    family: "comfyui",
    familyLabel: "ComfyUI",
    description: t.description,
    source: "comfyui",
  }));
}

// ---- generation ----

export async function comfySubmit(
  workflow: Record<string, unknown>,
  url = defaultComfyUrl()
): Promise<string> {
  const data = await jfetch<{ prompt_id: string }>(`${base(url)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: `arena-studio-${Math.random().toString(36).slice(2, 10)}`,
    }),
  });
  if (!data.prompt_id) throw new Error("comfyui returned no prompt_id");
  return data.prompt_id;
}

interface ComfyHistoryEntry {
  outputs?: Record<string, Record<string, any[]>>;
  status?: { completed?: boolean; status_str?: string; messages?: any[] };
}

function mediaKindFromNode(node: Record<string, any>): { list: any[]; kind: "video" | "image" | "audio" } | null {
  if (node.videos?.length) return { list: node.videos, kind: "video" };
  if (node.gifs?.length) return { list: node.gifs, kind: "video" };
  if (node.images?.length) return { list: node.images, kind: "image" };
  if (node.audio?.length) return { list: node.audio, kind: "audio" };
  return null;
}

function mimeFor(kind: "video" | "image" | "audio", filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, Record<string, string>> = {
    video: { mp4: "video/mp4", webm: "video/webm", webp: "image/webp", gif: "image/gif", mkv: "video/x-matroska" },
    image: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" },
    audio: { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg" },
  };
  return map[kind]?.[ext] ?? "application/octet-stream";
}

export async function comfyJob(
  promptId: string,
  url = defaultComfyUrl()
): Promise<BackendJobSnapshot> {
  // history returns { "<prompt_id>": {...} } or {} while queued/running
  const history = await jfetch<Record<string, ComfyHistoryEntry>>(`${base(url)}/history/${encodeURIComponent(promptId)}`);
  const entry = history[promptId];

  if (entry) {
    const files: BackendJobSnapshot["files"] = [];
    for (const [nodeId, node] of Object.entries(entry.outputs ?? {})) {
      const found = mediaKindFromNode(node);
      if (!found) continue;
      for (const f of found.list) {
        if (f.type && f.type !== "output") continue;
        const name = String(f.filename);
        files.push({
          name,
          mediaType: mimeFor(found.kind, name),
          kind: found.kind,
          size: typeof f.size === "number" ? f.size : undefined,
          url: `${base(url)}/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(
            f.subfolder ?? ""
          )}&type=output`,
        });
      }
    }
    const failed = entry.status?.status_str === "error";
    return {
      status: failed ? "failed" : "completed",
      phase: failed ? "execution error" : "done",
      progress: 1,
      files,
      error: failed ? "ComfyUI reported an execution error (check the ComfyUI console)" : undefined,
    };
  }

  // still queued or running — use the queue for a progress hint
  try {
    const queue = await jfetch<{ queue_running: [string, any, any][]; queue_pending: [string, any, any][] }>(
      `${base(url)}/queue`
    );
    const running = (queue.queue_running || []).some((r) => r[1] === promptId || String(r[1]) === promptId);
    const pendingPos = (queue.queue_pending || []).findIndex((r) => r[1] === promptId || String(r[1]) === promptId);
    if (running) {
      return { status: "running", phase: "executing workflow", progress: 0.6, files: [] };
    }
    if (pendingPos >= 0) {
      return {
        status: "queued",
        phase: `waiting in queue (position ${pendingPos + 1})`,
        progress: 0.1,
        files: [],
      };
    }
    return { status: "running", phase: "submitted", progress: 0.3, files: [] };
  } catch {
    return { status: "running", phase: "submitted", progress: 0.3, files: [] };
  }
}

export async function comfyCancel(promptId: string, url = defaultComfyUrl()): Promise<void> {
  await jfetch(`${base(url)}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
}

// Stream an output file from /view (supports Range).
export async function comfyFile(
  filename: string,
  subfolder: string | undefined,
  range: string | null,
  url = defaultComfyUrl()
): Promise<Response> {
  const target = `${base(url)}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(
    subfolder ?? ""
  )}&type=output`;
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  return fetch(target, { headers });
}

export { findComfyTemplate };
