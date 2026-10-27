// Hosted Wan API fallback (BYOK) — for machines without a GPU.
//
// Uses Alibaba Cloud Model Studio (DashScope) async video-generation API:
//   POST /api/v1/services/aigc/video-generation/video-synthesis  (X-DashScope-Async: enable)
//   GET  /api/v1/tasks/{task_id}
// and the synchronous multimodal generation API for Qwen-Image.
//
// Your API key is passed per-request from the client (BYOK) and never stored.
// Docs: https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
//
// This path is experimental: endpoints/parameters may change upstream.

import type { BackendJobSnapshot } from "./types";

export interface HostedConfig {
  apiKey: string;
  region?: "intl" | "cn";
}

function endpoint(region?: string): string {
  return (region === "cn" ? "https://dashscope.aliyuncs.com" : "https://dashscope-intl.aliyuncs.com") +
    "/api/v1";
}

async function jfetch<T>(url: string, apiKey: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        ...(init?.headers as Record<string, string>),
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data?.message || data?.code || `dashscope ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(t);
  }
}

// ---- video (async task) ----

export async function hostedSubmitVideo(
  cfg: HostedConfig,
  opts: { prompt: string; negativePrompt?: string; size?: string; duration?: number; model?: string }
): Promise<string> {
  const body = {
    model: opts.model || "wan2.2-t2v-plus",
    input: {
      prompt: opts.prompt,
      ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
    },
    parameters: {
      size: opts.size || "1280*720",
      duration: opts.duration ?? 5,
    },
  };
  const data = await jfetch<any>(`${endpoint(cfg.region)}/services/aigc/video-generation/video-synthesis`, cfg.apiKey, {
    method: "POST",
    headers: { "X-DashScope-Async": "enable" },
    body: JSON.stringify(body),
  });
  const id = data?.output?.task_id;
  if (!id) throw new Error(data?.message || "dashscope returned no task_id");
  return String(id);
}

export async function hostedTask(cfg: HostedConfig, taskId: string): Promise<BackendJobSnapshot> {
  const data = await jfetch<any>(`${endpoint(cfg.region)}/tasks/${encodeURIComponent(taskId)}`, cfg.apiKey);
  const out = data?.output ?? {};
  const status = String(out.task_status ?? "PENDING").toUpperCase();
  if (status === "SUCCEEDED") {
    const url = out.video_url || out.video?.url || out.results?.[0]?.url;
    if (!url) throw new Error("task succeeded but no video_url returned");
    return {
      status: "completed",
      phase: "done",
      progress: 1,
      files: [{ name: "video.mp4", mediaType: "video/mp4", kind: "video", url: String(url) }],
    };
  }
  if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
    return { status: "failed", phase: "failed", progress: 1, files: [], error: out.message || out.code || "task failed" };
  }
  return {
    status: status === "RUNNING" ? "running" : "queued",
    phase: status === "RUNNING" ? "generating (hosted)" : "queued (hosted)",
    progress: status === "RUNNING" ? 0.6 : 0.15,
    files: [],
  };
}

// ---- image (synchronous) ----
// Wrapped as an already-completed "job" — no external task id needed.

export async function hostedSubmitImage(
  cfg: HostedConfig,
  opts: { prompt: string; negativePrompt?: string; size?: string; model?: string }
): Promise<{ url: string; taskId: string }> {
  const body = {
    model: opts.model || "qwen-image",
    input: {
      messages: [
        {
          role: "user",
          content: [{ text: opts.prompt }],
        },
      ],
    },
    parameters: {
      n: 1,
      size: opts.size || "1328*1328",
      ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
    },
  };
  const data = await jfetch<any>(
    `${endpoint(cfg.region)}/services/aigc/multimodal-generation/generation`,
    cfg.apiKey,
    { method: "POST", body: JSON.stringify(body) },
    90000
  );
  const url =
    data?.output?.choices?.[0]?.message?.content?.find?.((c: any) => c?.image)?.image ||
    data?.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (!url) throw new Error(data?.message || "no image URL in response");
  return { url: String(url), taskId: `img_${Date.now().toString(36)}` };
}

export function hostedModelCatalog(modality?: string): import("./types").StudioModelInfo[] {
  const models: import("./types").StudioModelInfo[] = [
    {
      modelType: "wan2.2-t2v-plus",
      name: "Wan 2.2 T2V Plus · Cloud",
      modality: "video",
      family: "wan_cloud",
      familyLabel: "Hosted Wan",
      description: "Alibaba-hosted Wan 2.2 text-to-video. BYOK (DashScope). No GPU needed.",
      source: "dashscope",
      experimental: true,
    },
    {
      modelType: "qwen-image",
      name: "Qwen-Image · Cloud",
      modality: "image",
      family: "qwen_cloud",
      familyLabel: "Hosted Qwen",
      description: "Alibaba-hosted Qwen-Image text-to-image. BYOK (DashScope). No GPU needed.",
      source: "dashscope",
      experimental: true,
    },
  ];
  return modality ? models.filter((m) => m.modality === modality) : models;
}
